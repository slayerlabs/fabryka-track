"""Pinned ACI-Bench gradient-times-attention evaluation for native byte models.

Only Parquet data is downloaded; the upstream Python harness is never executed.
Scoring follows AxiomicLabs/ACI-Bench at REVISION, with exact UTF-8 byte offsets.
"""
import hashlib
import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from .native_model import TinyTransformer

REPO = 'AxiomicLabs/ACI-Bench'
REVISION = 'eaf77566763d6a924692d011499908cf05201941'
FILENAME = 'test/test-00000-of-00001.parquet'
DATA_SHA256 = '76d892d2c3295af87f4bbfef50344901b5f3526f4efee7dcc75b9c1aab5e04d8'
DATASET_SIZE = 5000
MAX_LENGTH = 256
SEED = 42
EPS = 1e-8
IMPLEMENTATION = 'native-byte-eager-attention-gradient-v1'


class NoValidItems(ValueError):
    def __init__(self, result):
        super().__init__('ACI scored no valid items: ' + json.dumps(result['skip_reasons'], sort_keys=True))
        self.result = result


def load_rows():
    from huggingface_hub import hf_hub_download
    import pyarrow.parquet as pq

    path = Path(hf_hub_download(REPO, FILENAME, repo_type='dataset', revision=REVISION))
    if hashlib.sha256(path.read_bytes()).hexdigest() != DATA_SHA256:
        raise ValueError('ACI dataset checksum mismatch')
    rows = pq.read_table(path).to_pylist()
    if len(rows) != DATASET_SIZE:
        raise ValueError('ACI dataset sample count mismatch')
    return rows


def byte_tokens_and_offsets(text, max_length):
    """Each UTF-8 byte overlaps its source character, including partial truncation."""
    tokens = list(text.encode('utf-8')[:max_length])
    offsets = []
    for index, char in enumerate(text):
        offsets.extend([(index, index + 1)] * min(len(char.encode('utf-8')), max_length - len(offsets)))
        if len(offsets) == max_length:
            break
    return tokens, offsets


def char_span_to_token_indices(offsets, start, end):
    return [index for index, (left, right) in enumerate(offsets)
            if (left, right) != (0, 0) and left < end and right > start]


def eager_forward(model, input_ids):
    """Use the unchanged native weights, exposing attention on the loss graph.

    The native encoder's fused attention cannot expose its probability gradients.
    This evaluation-only pre-norm forward performs the same operations eagerly.
    Input activations enable gradients even when every checkpoint weight is frozen.
    """
    if not isinstance(model, TinyTransformer) or model.training:
        raise ValueError('ACI requires an evaluation-mode native TinyTransformer')
    length = input_ids.shape[1]
    h = model.tokens(input_ids) + model.positions(torch.arange(length, device=input_ids.device))
    if not h.requires_grad:
        h.requires_grad_(True)
    mask = torch.ones(length, length, dtype=torch.bool, device=input_ids.device).triu(1)
    attentions = []
    for layer in model.blocks.layers:
        attention = layer.self_attn
        normalized = layer.norm1(h)
        q, k, v = F.linear(normalized, attention.in_proj_weight, attention.in_proj_bias).chunk(3, dim=-1)
        batch, _, width = q.shape
        head_width = width // attention.num_heads
        q, k, v = [value.reshape(batch, length, attention.num_heads, head_width).transpose(1, 2)
                   for value in (q, k, v)]
        weights = ((q * head_width ** -.5) @ k.transpose(-2, -1)).masked_fill(mask, float('-inf')).softmax(dim=-1)
        weights.retain_grad()
        attentions.append(weights)
        values = (weights @ v).transpose(1, 2).reshape(batch, length, width)
        h = h + layer.dropout1(F.linear(values, attention.out_proj.weight, attention.out_proj.bias))
        normalized = layer.norm2(h)
        h = h + layer.dropout2(layer.linear2(layer.dropout(layer.activation(layer.linear1(normalized)))))
    if model.blocks.norm is not None:
        h = model.blocks.norm(h)
    return model.head(model.norm(h)), attentions


def compute_saliency_matrix(attentions, gradients):
    """Sum |attention * d(causal shifted CE)/d(attention)| over layers/heads."""
    length = attentions[0].shape[-1]
    saliency = torch.zeros((length, length), dtype=torch.float32, device='cpu')
    for attention, gradient in zip(attentions, gradients):
        saliency += (attention.detach()[0] * gradient.detach()[0]).abs().sum(dim=0).to(device='cpu', dtype=torch.float32)
    return saliency.numpy()


def segment_scores(saliency, offsets, item):
    """Official segment priority and bidirectional linkage/control normalization."""
    segments = {seg['id']: char_span_to_token_indices(offsets, seg['charStart'], seg['charEnd'])
                for seg in item['segments']}
    related = sorted({token for sid in item['relatedSegmentIds'] for token in segments.get(sid, [])})
    unrelated = sorted({token for sid in item['unrelatedSegmentIds'] for token in segments.get(sid, [])})
    if not related or not unrelated:
        return None
    importance = saliency.sum(axis=0)
    related_mean = float(importance[related].mean())
    unrelated_mean = float(importance[unrelated].mean())
    priority = 100.0 * related_mean / (related_mean + unrelated_mean + EPS)
    pair_scores = []
    for a, b in item.get('keyLinkPairs', []):
        idx_a, idx_b = segments.get(a, []), segments.get(b, [])
        if not idx_a or not idx_b:
            continue
        pair_mass = (saliency[np.ix_(idx_a, idx_b)].sum() + saliency[np.ix_(idx_b, idx_a)].sum()) / (len(idx_a) * len(idx_b) * 2)
        combined = sorted(set(idx_a) | set(idx_b))
        control_mass = saliency[np.ix_(combined, unrelated)].sum() / (len(combined) * len(unrelated) + EPS)
        pair_scores.append(100.0 * pair_mass / (pair_mass + control_mass + EPS))
    return {'priority_score': priority, 'linkage_score': float(np.mean(pair_scores)) if pair_scores else None,
            'related_mean': related_mean, 'unrelated_mean': unrelated_mean, 'valid_link_pairs': len(pair_scores)}


def run_item(model, item, max_length):
    item = dict(item)
    for key in ('segments', 'relatedSegmentIds', 'unrelatedSegmentIds', 'keyLinkPairs'):
        if isinstance(item.get(key), str):
            item[key] = json.loads(item[key])
    text = f"{item['context']} {item['question']}"
    tokens, offsets = byte_tokens_and_offsets(text, max_length)
    original_tokens = len(text.encode('utf-8'))
    result = {'id': item['id'], 'num_tokens': len(tokens), 'original_tokens': original_tokens,
              'truncated': original_tokens > len(tokens)}
    if len(tokens) < 4:
        return {**result, 'reason': 'too_short'}
    # Re-enable gradients without changing parameters' requires_grad flags or .grad.
    # autograd.grad requests only attention derivatives; no optimizer state is touched.
    with torch.inference_mode(False), torch.enable_grad():
        inputs = torch.tensor([tokens], dtype=torch.long, device=model.tokens.weight.device)
        logits, attentions = eager_forward(model, inputs)
        loss = F.cross_entropy(logits[:, :-1].reshape(-1, 256), inputs[:, 1:].reshape(-1))
        if not torch.isfinite(loss):
            return {**result, 'reason': 'bad_loss'}
        gradients = torch.autograd.grad(loss, attentions)
        saliency = compute_saliency_matrix(attentions, gradients)
    # Nothing retaining the graph escapes this function; each item is independent.
    if not np.isfinite(saliency).all():
        return {**result, 'reason': 'bad_saliency'}
    if saliency.sum() <= 0:
        return {**result, 'reason': 'zero_saliency'}
    scores = segment_scores(saliency, offsets, item)
    if scores is None:
        return {**result, 'reason': 'empty_segment_tokens'}
    if not all(np.isfinite(value) for value in scores.values() if value is not None):
        return {**result, 'reason': 'bad_score'}
    return {**result, **scores}


def evaluate(adapter, mode, rows=None):
    if mode not in ('smoke', 'full'):
        raise ValueError('Unknown ACI evaluation mode')
    model = adapter.model
    if not isinstance(model, TinyTransformer) or model.training:
        raise ValueError('ACI requires an evaluation-mode native TinyTransformer')
    rows = load_rows() if rows is None else list(rows)
    available = len(rows)
    if mode == 'smoke' and len(rows) > 10:
        rows = random.Random(SEED).sample(rows, 10)
    max_length = min(MAX_LENGTH, adapter.context_length, model.positions.num_embeddings)
    if max_length < 1:
        raise ValueError('ACI requires a positive context length')
    items = []
    for item in rows:
        try:
            result = run_item(model, item, max_length)
        except torch.OutOfMemoryError:
            raise
        except Exception as exc:
            result = {'id': item.get('id'), 'reason': 'error', 'detail': f'{type(exc).__name__}: {exc}'}
        items.append(result)
    valid = [item for item in items if 'reason' not in item]
    reasons = dict(Counter(item['reason'] for item in items if 'reason' in item))
    result = {'samples': len(valid), 'skipped': len(items) - len(valid), 'errors': reasons.get('error', 0),
              'attempted': len(items), 'available': available, 'skip_reasons': reasons,
              'truncated': sum(item.get('truncated', False) for item in items),
              'dataset_revisions': {REPO: REVISION}, 'dataset_sha256': DATA_SHA256, 'split': 'test',
              'harness_revision': REVISION, 'implementation': IMPLEMENTATION, 'model_type': 'causal',
              'token_unit': 'utf8_bytes', 'offset_mapping': 'each byte overlaps its source Unicode character',
              'loss': 'mean causal shifted cross entropy', 'attention_implementation': 'eager',
              'max_length': max_length, 'requested_max_length': MAX_LENGTH, 'seed': SEED,
              'selection': 'seeded random sample' if mode == 'smoke' else 'all items in dataset order',
              'sample_digest': hashlib.sha256(json.dumps([item.get('id') for item in items]).encode()).hexdigest(),
              'device': str(model.tokens.weight.device), 'dtype': str(model.tokens.weight.dtype),
              'torch_version': torch.__version__, 'numpy_version': np.__version__}
    if not valid:
        raise NoValidItems(result)
    priority = float(np.mean([item['priority_score'] for item in valid]))
    linkage_values = [item['linkage_score'] for item in valid if item['linkage_score'] is not None]
    linkage = float(np.mean(linkage_values)) if linkage_values else 50.0
    return {**result, 'priority_score': priority, 'linkage_score': linkage,
            'linkage_samples': len(linkage_values), 'aci_score': (priority + linkage) / 2.0}
