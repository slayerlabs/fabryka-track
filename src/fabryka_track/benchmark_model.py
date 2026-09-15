"""UTF-8 byte model adapter for lm-evaluation-harness (no model downloads)."""
import torch
from itertools import islice
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
        return [pair[0] for pair in self.score_many([('',r.args[0]) for r in requests])]

    def generate_until(self, requests):
        raise NotImplementedError('TinyLM suite uses likelihood tasks only.')
