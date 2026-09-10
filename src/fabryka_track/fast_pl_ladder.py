"""Versioned, fixed-sample Polish diagnostics for small byte-level models.

Companion to the English ``fast_ladder``. The signals here are the ones that
actually discriminate at 8M-32M parameters (see the research thread): held-out
Polish bits-per-byte as the continuous primary axis, Polish agreement minimal
pairs as a confirming morphosyntax axis, and a synthetic in-context copy probe.
Scores are internal diagnostics, not official ranks.
"""
import hashlib
import json
import math
import os
from pathlib import Path

from .fast_ladder import likelihood

PROTOCOL = 'fast-pl-v1'
COMPONENTS = {
    'pl_lm': {'name': 'Held-out Polish LM', 'weight': .60, 'size': '500k-1M UTF-8 bytes', 'metric': 'NLL / BPB'},
    'pl_multiblimp': {'name': 'MultiBLiMP-PL (short span)', 'weight': .30, 'size': 'short agreement pairs', 'metric': 'margin + accuracy'},
    'pl_induction': {'name': 'Induction / copy', 'weight': .10, 'size': 'synthetic pairs', 'metric': 'margin + accuracy'},
}


def pl_score(results):
    """Weighted mean of component ``normalized`` values; ``None`` until every component is present. Negatives kept."""
    values = [results.get(k, {}).get('normalized') for k in COMPONENTS]
    return sum(v * COMPONENTS[k]['weight'] for k, v in zip(COMPONENTS, values)) if all(v is not None for v in values) else None


def pack():
    folder = Path(os.environ.get('TRACK_FAST_PL_LADDER_DIR', 'fast-pl-ladder-v1'))
    manifest = json.loads((folder / 'manifest.json').read_text())
    if manifest['protocol'] != PROTOCOL:
        raise ValueError('Wrong ladder protocol')
    return folder, manifest


def evaluate(key, model, mode):
    folder, manifest = pack()
    raw = (folder / (key + '.jsonl')).read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest['components'][key]['sha256']:
        raise ValueError('Evaluation pack checksum mismatch')
    rows = [json.loads(line) for line in raw.decode().splitlines()]
    if mode == 'smoke':
        rows = rows[:10]
    result = {'protocol': PROTOCOL, 'weight': COMPONENTS[key]['weight'], 'sample_digest': hashlib.sha256(raw).hexdigest(),
              'source': manifest['sources'][key], 'mode': mode}
    if key == 'pl_lm':
        import torch
        data = rows[0]['text'].encode()
        data = data[:8192] if mode == 'smoke' else data
        total = 0.0
        count = 0
        with torch.inference_mode():
            for start in range(0, len(data), model.context_length):
                target = list(data[start:start + model.context_length])
                inputs = [data[start - 1] if start else 32] + target[:-1]
                logits = model.model(torch.tensor([inputs], device=model._device))[0].float().log_softmax(-1)
                y = torch.tensor(target, device=model._device)
                total -= logits.gather(1, y[:, None]).sum().item()
                count += len(target)
        nll = total / count
        bpb = nll / math.log(2)
        return {**result, 'samples': count, 'unit': 'UTF-8 bytes', 'nll': nll, 'bpb': bpb, 'normalized': 1 - bpb / 8,
                'scoring': 'non-overlapping context-length blocks, preceding byte prefix; every byte scored once'}
    # pl_multiblimp and pl_induction are forced-choice pairs scored by continuation log-likelihood margin.
    margins = []
    scaled = []
    correct = []
    for row in rows:
        margin = likelihood(model, row['context'], row['good']) - likelihood(model, row['context'], row['bad'])
        margins.append(margin)
        correct.append(int(margin > 0))
        bits = margin / (max(len(row['good'].encode()), len(row['bad'].encode()), 1) * math.log(2))
        scaled.append(math.tanh(bits))
    return {**result, 'samples': len(rows), 'comparisons': len(margins), 'accuracy': sum(correct) / len(correct),
            'mean_margin_nats': sum(margins) / len(margins), 'normalized': sum(scaled) / len(scaled)}
