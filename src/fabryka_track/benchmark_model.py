"""Checkpoint adapters for lm-evaluation-harness (no model downloads).

Two protocols, one likelihood contract:
- ``ByteCheckpointLM`` — UTF-8 byte model (vocab 256, TinyTransformer, .pt payload).
- ``TokenCheckpointLM`` — subword model (tokenizer + TokenGPT, safetensors model dir).

Both bucket scoring windows by length because learned positions make left padding
change the score; the only difference is the unit (byte vs subword token) and loader.
The byte and token protocols are NOT interchangeable — a run is scored under one.

TokenCheckpointLM is hardened to load untrusted external model dirs (register-external-
model path): safetensors-only weights (no pickle), checkpoint contained within model_dir,
and bounded architecture dims so a hostile config cannot OOM the runner.
"""
import torch
from itertools import islice
from lm_eval.api.model import LM
from .native_model import TinyTransformer


class ByteCheckpointLM(LM):
    def __init__(self, checkpoint, device="cpu", *, payload=None, rolling_policy='sliding'):
        super().__init__()
        if payload is None:
            payload = torch.load(checkpoint, map_location='cpu', weights_only=True)
        if rolling_policy not in ('sliding','harness'):
            raise ValueError('Unknown rolling policy')
        self.rolling_policy = rolling_policy
        self.cfg = payload['config']
        self.context_length = self.cfg['context_length']
        self.model = TinyTransformer(**{k: self.cfg[k] for k in ('width','layers','heads','context_length')}).eval()
        self.model.load_state_dict(payload['state_dict'], strict=True)
        self._device = torch.device(device)
        self.model.to(self._device)
        self.truncated_requests = 0
        self.total_requests = 0

    def score(self, context, continuation):
        return self.score_many([(context, continuation)])[0]

    def score_many(self, pairs, batch_size=512):
        """Fuse causal prefix predictions and stream only the shifted windows.

        Right padding cannot affect earlier causal predictions. Once learned
        absolute positions shift, each byte still gets its own maximal window.
        Keep at most 64 requests' token arrays and one window batch in memory.
        """
        totals=[0.0 for _ in pairs]; greedy=[True for _ in pairs]
        iterator=iter(enumerate(pairs))
        while block:=list(islice(iterator,64)):
            prefixes=[]; overflow=[]
            for request,(context,continuation) in block:
                prefix=list(context.encode('utf-8')) or [32]; target=list(continuation.encode('utf-8'))
                self.total_requests+=1
                if len(prefix)+len(target)-1>self.context_length:self.truncated_requests+=1
                tokens=prefix+target
                stop=min(len(tokens)-1,self.context_length)
                if target and len(prefix)<=stop:
                    prefixes.append((request,tokens[:stop],len(prefix)-1,tokens[len(prefix):stop+1]))
                overflow.append((request,tokens,max(len(prefix),self.context_length+1)))
            if prefixes:
                size=min(batch_size,max(1,8192//max(len(row[1]) for row in prefixes)))
                for chunk,values,guesses in self._batches(prefixes,size,self._score_prefix_chunk):
                    for row,value,guess in zip(chunk,values,guesses):
                        totals[row[0]]+=value;greedy[row[0]]=greedy[row[0]] and guess
            windows=((request,tokens[index-self.context_length:index],tokens[index])
                     for request,tokens,start in overflow for index in range(start,len(tokens)))
            size=min(batch_size,max(1,8192//self.context_length))
            for chunk,values,guesses in self._batches(windows,size,self._score_chunk):
                for row,value,guess in zip(chunk,values,guesses):
                    totals[row[0]]+=value;greedy[row[0]]=greedy[row[0]] and guess
        return list(zip(totals,greedy))

    def _batches(self, rows, size, scorer):
        iterator=iter(rows)
        with torch.inference_mode():
            while pending:=list(islice(iterator,size)):
                start=0
                while start<len(pending):
                    chunk=pending[start:start+size]
                    try:values,guesses=scorer(chunk)
                    except torch.OutOfMemoryError:
                        if size==1:raise
                        size=max(1,size//2)
                        if self._device.type=='cuda':torch.cuda.empty_cache()
                        continue
                    yield chunk,values,guesses
                    start+=len(chunk)

    def _score_prefix_chunk(self, chunk):
        length=max(len(row[1]) for row in chunk)
        x=torch.tensor([row[1]+[32]*(length-len(row[1])) for row in chunk],dtype=torch.long,device=self._device)
        logits=self.model(x).log_softmax(-1)
        values=[];greedy=[]
        for index,(_,_,start,target) in enumerate(chunk):
            scores=logits[index,start:start+len(target)]
            y=torch.tensor(target,dtype=torch.long,device=self._device)
            # Sum in Python's double precision, matching the bytewise adapter.
            values.append(sum(scores.gather(1,y[:,None]).flatten().tolist()))
            greedy.append(bool(scores.argmax(-1).eq(y).all().item()))
        return values,greedy

    def score_many_reference(self, pairs, batch_size=512):
        """Original bytewise scorer, retained for bounded equivalence checks."""
        totals=[0.0 for _ in pairs]; greedy=[True for _ in pairs]; buckets={}
        for request,(context,continuation) in enumerate(pairs):
            prefix=list(context.encode('utf-8')) or [32];target=list(continuation.encode('utf-8'))
            self.total_requests += 1
            if len(prefix)+len(target)-1 > self.context_length:self.truncated_requests += 1
            tokens=prefix+target
            for index,byte in enumerate(target,len(prefix)):
                window=tokens[max(0,index-self.context_length):index]
                buckets.setdefault(len(window),[]).append((request,window,byte))
        with torch.inference_mode():
            for rows in buckets.values():
                start=0
                size=min(batch_size, max(1, 8192 // len(rows[0][1])))
                while start<len(rows):
                    chunk=rows[start:start+size]
                    try:
                        values,guesses=self._score_chunk(chunk)
                    except torch.OutOfMemoryError:
                        if size==1:raise
                        size=max(1,size//2)
                        if self._device.type=='cuda':torch.cuda.empty_cache()
                        continue
                    for (request,_,_),value,guess in zip(chunk,values,guesses):
                        totals[request]+=value;greedy[request]=greedy[request] and guess
                    start+=len(chunk)
        return list(zip(totals,greedy))

    def _score_chunk(self, chunk):
        # Scope tensors to one attempt so an OOM retry can release all allocations.
        x=torch.tensor([item[1] for item in chunk],dtype=torch.long,device=self._device)
        y=torch.tensor([item[2] for item in chunk],dtype=torch.long,device=self._device)
        logits=self.model(x)[:,-1,:].log_softmax(-1)
        return logits.gather(1,y[:,None]).flatten().tolist(), logits.argmax(-1).eq(y).tolist()

    def loglikelihood(self, requests):
        return self.score_many([tuple(r.args) for r in requests])

    def loglikelihood_rolling(self, requests):
        """Legacy sliding by default; opt-in official harness block windows.

        Work in bytes throughout: a window may split a Unicode code point and
        must never decode/re-encode it. Each document starts a new prefix.
        """
        if self.rolling_policy == 'sliding':
            return [pair[0] for pair in self.score_many([('', r.args[0]) for r in requests])]
        from lm_eval.utils import get_rolling_token_windows
        totals = []
        size = max(1, 8192 // self.context_length)
        for request in requests:
            tokens = list(request.args[0].encode('utf-8'))
            self.total_requests += 1
            if len(tokens) > self.context_length:
                self.truncated_requests += 1
            windows = ((0, inputs, len(inputs) - len(targets), targets)
                       for inputs, targets in get_rolling_token_windows(
                           tokens, prefix_token=32, max_seq_len=self.context_length, context_len=1))
            total = 0.0
            for _, values, _ in self._batches(windows, size, self._score_prefix_chunk):
                total += sum(values)
            totals.append(total)
        return totals

    def generate_until(self, requests):
        raise NotImplementedError('TinyLM suite uses likelihood tasks only.')


class TokenCheckpointLM(LM):
    """Subword (tokenizer + TokenGPT) adapter — token-level sibling of ByteCheckpointLM.

    ``model_dir`` is a checkpoint directory laid out like the published HF export:
    ``config.json`` (vocab_size/d_model/n_layer/n_head/block_size), ``tokenizer.json``
    (HF tokenizers) and one or more ``ckpt_*.safetensors``. ``checkpoint`` selects a
    named safetensors file; when omitted the highest-step snapshot is used.

    The likelihood protocol mirrors ByteCheckpointLM exactly (length-bucketed causal
    windows, same truncation accounting) — only the unit is a subword token, not a byte.
    """

    # Upper bounds so a hostile/foreign config.json cannot OOM the runner (Wartownik).
    _MAX_DIMS = {"vocab_size": 300_000, "d_model": 8192, "n_layer": 128,
                 "n_head": 128, "block_size": 32768}

    def __init__(self, model_dir, checkpoint=None, device="cpu"):
        super().__init__()
        import os, re, glob, json
        from tokenizers import Tokenizer
        from safetensors.torch import load_file
        from .token_model import TokenGPT
        model_dir = os.path.realpath(model_dir)
        with open(os.path.join(model_dir, "config.json")) as fh:
            cfg = json.load(fh)
        dims = {k: int(cfg[k]) for k in ("vocab_size", "d_model", "n_layer", "n_head", "block_size")}
        for name, value in dims.items():
            if not 1 <= value <= self._MAX_DIMS[name]:
                raise ValueError(f"config {name}={value} out of bounds (1..{self._MAX_DIMS[name]})")
        self.context_length = dims["block_size"]
        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.model = TokenGPT(dims["vocab_size"], dims["d_model"], dims["n_layer"],
                              dims["n_head"], dims["block_size"]).eval()
        if checkpoint is None:
            snaps = glob.glob(os.path.join(model_dir, "ckpt_*.safetensors"))
            if not snaps:
                raise FileNotFoundError(f"no ckpt_*.safetensors in {model_dir}")
            checkpoint = max(snaps, key=lambda p: int(re.search(r"ckpt_(\d+)", os.path.basename(p)).group(1)))
        else:
            checkpoint = os.path.realpath(os.path.join(model_dir, checkpoint))
        # Containment: the checkpoint must resolve inside model_dir (block ../ traversal).
        if os.path.commonpath([checkpoint, model_dir]) != model_dir:
            raise ValueError(f"checkpoint escapes model_dir: {checkpoint}")
        state = load_file(checkpoint)
        missing, unexpected = self.model.load_state_dict(state, strict=False)
        # head.weight is tied to the token embedding, so its absence is expected.
        if unexpected or missing not in ([], ["head.weight"]):
            raise ValueError(f"state dict mismatch: missing={missing} unexpected={unexpected}")
        self._device = torch.device(device)
        self.model.to(self._device)
        self.checkpoint = checkpoint
        self.truncated_requests = 0
        self.total_requests = 0

    def score(self, context, continuation):
        return self.score_many([(context, continuation)])[0]

    def score_many(self, pairs, batch_size=256):
        """Batched causal-window loglikelihood, windows grouped by length.

        Learned positions (nn.Embedding) make left padding change the score, so we
        bucket by window length exactly like ByteCheckpointLM; the only difference is
        the tokenizer (subword ids) instead of raw UTF-8 bytes.
        """
        totals=[0.0 for _ in pairs]; greedy=[True for _ in pairs]; buckets={}
        for request,(context,continuation) in enumerate(pairs):
            prefix=self.tok.encode(context).ids or [self.tok.encode(" ").ids[0]]
            target=self.tok.encode(continuation).ids
            self.total_requests += 1
            if len(prefix)+len(target)-1 > self.context_length:self.truncated_requests += 1
            tokens=prefix+target
            for index,token in enumerate(target,len(prefix)):
                window=tokens[max(0,index-self.context_length):index]
                buckets.setdefault(len(window),[]).append((request,window,token))
        with torch.inference_mode():
            for rows in buckets.values():
                for start in range(0,len(rows),batch_size):
                    chunk=rows[start:start+batch_size]
                    x=torch.tensor([item[1] for item in chunk],dtype=torch.long,device=self._device)
                    y=torch.tensor([item[2] for item in chunk],dtype=torch.long,device=self._device)
                    logits=self.model(x)[:,-1,:].log_softmax(-1)
                    values=logits.gather(1,y[:,None]).flatten().tolist()
                    guesses=logits.argmax(-1).eq(y).tolist()
                    for (request,_,_),value,guess in zip(chunk,values,guesses):
                        totals[request]+=value;greedy[request]=greedy[request] and guess
        return list(zip(totals,greedy))

    def loglikelihood(self, requests):
        return self.score_many([tuple(r.args) for r in requests])

    def loglikelihood_rolling(self, requests):
        return [pair[0] for pair in self.score_many([('',r.args[0]) for r in requests])]

    def generate_until(self, requests):
        raise NotImplementedError('Token suite uses likelihood tasks only.')
