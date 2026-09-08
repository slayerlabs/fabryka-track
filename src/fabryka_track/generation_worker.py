"""Sample the native byte vocabulary without downloading another model."""
import hashlib
import json
import sys
import time
import torch
from .native_model import TinyTransformer

def sample(path, options):
    torch.set_num_threads(1)
    torch.manual_seed(options['seed'])
    started = time.monotonic()
    payload = torch.load(path, map_location='cpu', weights_only=True)
    cfg = payload['config']
    model = TinyTransformer(**{k: cfg[k] for k in ('width','layers','heads','context_length')}).eval()
    model.load_state_dict(payload['state_dict'], strict=True)
    prefix = list(options['prompt'].encode('utf-8'))
    tokens = prefix[:]
    with torch.inference_mode():
        for _ in range(options['max_new_bytes']):
            x = torch.tensor([tokens[-cfg['context_length']:]], dtype=torch.long)
            logits = model(x)[0, -1]
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
            'elapsed_seconds': round(time.monotonic()-started, 3), 'settings': options}

if __name__ == '__main__':
    print(json.dumps(sample(sys.argv[1], json.load(sys.stdin))))
