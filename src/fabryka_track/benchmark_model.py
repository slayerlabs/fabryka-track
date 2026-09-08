"""UTF-8 byte model adapter for lm-evaluation-harness (no model downloads)."""
import torch
from lm_eval.api.model import LM
from .training import TinyTransformer


class ByteCheckpointLM(LM):
    def __init__(self, checkpoint):
        super().__init__()
        payload = torch.load(checkpoint, map_location='cpu', weights_only=True)
        self.cfg = payload['config']
        self.context_length = self.cfg['context_length']
        self.model = TinyTransformer(**{k: self.cfg[k] for k in ('width','layers','heads','context_length')}).eval()
        self.model.load_state_dict(payload['state_dict'], strict=True)
        self._device = torch.device('cpu')
        self.truncated_requests = 0
        self.total_requests = 0

    def score(self, context, continuation):
        prefix = list(context.encode('utf-8')) or [32]
        target = list(continuation.encode('utf-8'))
        self.total_requests += 1
        if len(prefix)+len(target)-1 > self.context_length:
            self.truncated_requests += 1
        # Score every continuation byte once, with the largest available context.
        # Group equal-length windows to avoid positional changes from padding.
        buckets = {}
        tokens = prefix + target
        for i, byte in enumerate(target, len(prefix)):
            window = tokens[max(0,i-self.context_length):i]
            buckets.setdefault(len(window), []).append((window, byte))
        total, greedy = 0., True
        with torch.inference_mode():
            for rows in buckets.values():
                for start in range(0,len(rows),128):
                    chunk = rows[start:start+128]
                    x = torch.tensor([r[0] for r in chunk], dtype=torch.long)
                    y = torch.tensor([r[1] for r in chunk], dtype=torch.long)
                    logits = self.model(x)[:,-1,:]
                    total += logits.log_softmax(-1).gather(1,y[:,None]).sum().item()
                    greedy = greedy and bool((logits.argmax(-1)==y).all())
        return total, greedy

    def loglikelihood(self, requests):
        return [self.score(*r.args) for r in requests]

    def loglikelihood_rolling(self, requests):
        return [self.score('',r.args[0])[0] for r in requests]

    def generate_until(self, requests):
        raise NotImplementedError('TinyLM suite uses likelihood tasks only.')
