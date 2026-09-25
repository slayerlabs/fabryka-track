"""Real CPU next-token training; publish gradients using the Fabryka SDK.

Run with FABRYKA_API_KEY set. Uses a tiny generated corpus, no rented GPU.
"""
import json
import math
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import torch
from torch import nn
from fabryka import RunClient


def main():
    if not os.environ.get('FABRYKA_API_KEY'):
        raise SystemExit('Set FABRYKA_API_KEY before running this smoke test.')
    torch.manual_seed(42)
    torch.set_num_threads(2)
    steps, length, batch_size, threshold = 120, 32, 8, 0.5
    corpus = torch.tensor(list(('the cat sat on the mat. the dog sat on the rug.\n' * 100).encode()))

    class TinyLanguageModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.Embedding(256, 32)
            self.position = nn.Embedding(length, 32)
            self.block = nn.TransformerEncoderLayer(32, 2, 64, dropout=0., batch_first=True)
            self.head = nn.Linear(32, 256)

        def forward(self, tokens):
            hidden = self.embedding(tokens) + self.position(torch.arange(length))
            mask = torch.ones(length, length, dtype=torch.bool).triu(1)
            return self.head(self.block(hidden, src_mask=mask))

    model = TinyLanguageModel()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.01)
    run = RunClient(spool_dir=tempfile.mkdtemp(prefix='fabryka-gradient-smoke-'))
    run.init(project='sdk-smoke-tests', name='SDK gradient smoke · tiny CPU language model · ' + datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
             config={'model': 'Tiny causal Transformer (synthetic smoke corpus)', 'compute': 'cpu',
                     'steps': steps, 'batch_size': batch_size, 'context_length': length,
                     'parameters': sum(p.numel() for p in model.parameters()), 'seed': 42,
                     'learning_rate': 0.01, 'optimizer': 'AdamW', 'classification': 'smoke-test'},
             note='Real next-byte CPU training on repeated generated sentences. Integration smoke test, not a model-quality benchmark.')
    rid = run.run_id
    start = time.monotonic()
    rows = []
    try:
        for step in range(1, steps + 1):
            offsets = torch.randint(len(corpus) - length - 1, (batch_size,))
            x = torch.stack([corpus[i:i+length] for i in offsets])
            y = torch.stack([corpus[i+1:i+length+1] for i in offsets])
            optimizer.zero_grad(set_to_none=True)
            loss = nn.functional.cross_entropy(model(x).reshape(-1, 256), y.reshape(-1))
            loss.backward()
            norm = float(nn.utils.clip_grad_norm_(model.parameters(), threshold, error_if_nonfinite=True))
            after = float(torch.linalg.vector_norm(torch.stack([p.grad.norm() for p in model.parameters() if p.grad is not None])))
            optimizer.step()
            values = {'train/loss': float(loss.detach()), 'optimizer/gradient_norm': norm,
                      'optimizer/gradient_norm_after_clip': after,
                      'optimizer/gradient_clip_threshold': threshold,
                      'optimizer/gradient_clipped': float(norm > threshold),
                      'throughput/tokens_sec': step * x.numel() / (time.monotonic() - start),
                      'training/tokens_seen': step * x.numel(), 'progress': 100 * step / steps}
            assert all(math.isfinite(v) for v in values.values())
            run.log(values, step=step)
            rows.append({'step': step, **values})
        run.finish(timeout=60)
    except BaseException:
        run.finish(state='failed', timeout=10)
        raise
    result = {'run_id': rid, 'url': f'{run.api_url}/run/{rid}', 'steps': steps,
              'first_loss': rows[0]['train/loss'], 'last_loss': rows[-1]['train/loss'],
              'gradient_min': min(r['optimizer/gradient_norm'] for r in rows),
              'gradient_max': max(r['optimizer/gradient_norm'] for r in rows),
              'clipped_steps': sum(r['optimizer/gradient_clipped'] for r in rows)}
    output = Path(os.environ.get('SMOKE_RESULT_PATH', '/tmp/fabryka-gradient-smoke-result.json'))
    output.write_text(json.dumps({'summary': result, 'measurements': rows}, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
