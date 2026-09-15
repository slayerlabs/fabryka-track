"""Sample the native byte vocabulary without downloading another model."""
import hashlib
import json
import sys
import time
import torch
from torch.nn import functional as F
from .native_model import TinyTransformer

class CachedDecoder:
    """Reuse causal attention keys/values while absolute positions stay fixed."""

    def __init__(self, model):
        self.model = model
        self.length = 0
        self.cache = [None] * len(model.blocks.layers)

    def next_logits(self, tokens):
        context = self.model.positions.num_embeddings
        # Sliding the window changes every learned absolute position and every
        # layer's prefix. Rebuild, rather than reusing stale keys and values.
        rebuild = self.length == 0 or self.length >= context
        if rebuild:
            self.length = 0
            self.cache = [None] * len(self.cache)
            current = tokens[-context:]
        else:
            current = tokens[-1:]
        x = torch.tensor([current], dtype=torch.long)
        positions = torch.arange(self.length, self.length + x.shape[1])
        h = self.model.tokens(x) + self.model.positions(positions)
        for i, layer in enumerate(self.model.blocks.layers):
            attention = layer.self_attn
            q, k, v = F.linear(layer.norm1(h), attention.in_proj_weight,
                               attention.in_proj_bias).chunk(3, dim=-1)
            def split_heads(t):
                return t.view(1, -1, attention.num_heads, attention.head_dim).transpose(1, 2)
            q, k, v = map(split_heads, (q, k, v))
            if self.cache[i] is not None:
                previous_k, previous_v = self.cache[i]
                k, v = torch.cat((previous_k, k), dim=2), torch.cat((previous_v, v), dim=2)
            self.cache[i] = (k, v)
            # A single new query can attend to all cached positions. A prefill
            # has multiple queries and must mask their future positions.
            attended = F.scaled_dot_product_attention(q, k, v, is_causal=rebuild)
            attended = attended.transpose(1, 2).reshape(1, -1, attention.embed_dim)
            h = h + layer.dropout1(attention.out_proj(attended))
            h = h + layer.dropout2(layer.linear2(layer.dropout(layer.activation(layer.linear1(layer.norm2(h))))))
        self.length += x.shape[1]
        return self.model.head(self.model.norm(h[:, -1]))[0]


def sample(path, options, *, time_budget_seconds=70):
    torch.set_num_threads(1)
    torch.manual_seed(options['seed'])
    started = time.monotonic()
    payload = torch.load(path, map_location='cpu', weights_only=True)
    cfg = payload['config']
    model = TinyTransformer(**{k: cfg[k] for k in ('width','layers','heads','context_length')}).eval()
    model.load_state_dict(payload['state_dict'], strict=True)
    decoder = CachedDecoder(model)
    prefix = list(options['prompt'].encode('utf-8'))
    tokens = prefix[:]
    finish_reason = 'length'
    with torch.inference_mode():
        for _ in range(options['max_new_bytes']):
            if len(tokens) > len(prefix) and time.monotonic() - started >= time_budget_seconds:
                finish_reason = 'time_limit'
                break
            logits = decoder.next_logits(tokens)
            if options['temperature'] == 0:
                next_byte = logits.argmax().item()
            else:
                values, indices = torch.topk(logits / options['temperature'], options['top_k'])
                next_byte = indices[torch.multinomial(values.softmax(-1), 1)].item()
            tokens.append(next_byte)
    generated = bytes(tokens[len(prefix):])
    with open(path, 'rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(f.read()).hexdigest()
    return {'prompt': options['prompt'], 'continuation': generated.decode('utf-8', errors='replace'),
            'generated_bytes': len(generated), 'raw_bytes_hex': generated.hex(),
            'invalid_utf8': generated.decode('utf-8', errors='replace').count('\ufffd'),
            'checkpoint_step': payload.get('best_step'), 'checkpoint_sha256': digest,
            'context_bytes': cfg['context_length'], 'prompt_truncated': len(prefix) > cfg['context_length'],
            'finish_reason': finish_reason, 'decoder': 'cached-causal-v1',
            'elapsed_seconds': round(time.monotonic()-started, 3), 'settings': options}

if __name__ == '__main__':
    print(json.dumps(sample(sys.argv[1], json.load(sys.stdin))))
