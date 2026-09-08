"""UTF-8 byte model adapter for lm-evaluation-harness (no model downloads)."""
import torch
from lm_eval.api.model import LM
from .native_model import TinyTransformer


class ByteCheckpointLM(LM):
    def __init__(self, checkpoint, device="cpu"):
        super().__init__()
        payload = torch.load(checkpoint, map_location='cpu', weights_only=True)
        self.cfg = payload['config']
        self.context_length = self.cfg['context_length']
        self.model = TinyTransformer(**{k: self.cfg[k] for k in ('width','layers','heads','context_length')}).eval()
        self.model.load_state_dict(payload['state_dict'], strict=True)
        self._device = torch.device(device)
        self.model.to(self._device)
        self.truncated_requests = 0
        self.total_requests = 0

    def score(self, context, continuation):
        prefix = list(context.encode('utf-8')) or [32]
        target = list(continuation.encode('utf-8'))
        self.total_requests += 1
        if len(prefix)+len(target)-1 > self.context_length:
            self.truncated_requests += 1
        # Causality allows all growing-prefix positions in one forward pass.
        # Beyond the context boundary use the original shifted-window protocol.
        tokens = prefix + target
        total, greedy = 0., True
        initial_end = min(len(tokens)-1, self.context_length)
        with torch.inference_mode():
            if len(prefix) <= initial_end:
                x = torch.tensor([tokens[:initial_end]], dtype=torch.long, device=self._device)
                y = torch.tensor(tokens[len(prefix):initial_end+1], dtype=torch.long, device=self._device)
                logits = self.model(x)[0, len(prefix)-1:initial_end]
                total += logits.log_softmax(-1).gather(1, y[:,None]).sum().item()
                greedy = bool((logits.argmax(-1)==y).all())
            for start in range(max(len(prefix), initial_end+1), len(tokens), 128):
                end = min(start+128, len(tokens))
                x = torch.tensor([tokens[i-self.context_length:i] for i in range(start,end)], dtype=torch.long, device=self._device)
                y = torch.tensor(tokens[start:end], dtype=torch.long, device=self._device)
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
