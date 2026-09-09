"""Versioned, fixed-sample English diagnostics. Scores are internal, not official ranks."""
import hashlib
import json
import math
import os
from pathlib import Path

PROTOCOL='fast-en-v1'
COMPONENTS={
 'fast_lm': {'name':'Held-out LM','weight':.40,'size':'500k–1M UTF-8 bytes','metric':'NLL / BPB'},
 'fast_blimp': {'name':'BLiMP-fast','weight':.35,'size':'~8.5k pairs','metric':'margin + accuracy'},
 'fast_supplement': {'name':'BLiMP Supplement','weight':.10,'size':'all available pairs','metric':'margin + accuracy'},
 'fast_ewok': {'name':'EWoK-fast','weight':.05,'size':'1,500 items, both contexts','metric':'preference margin'},
 'fast_arc': {'name':'ARC-Easy','weight':.10,'size':'1,000 items','metric':'MC logprob'},
}


def fast_score(results):
    values=[results.get(k,{}).get('normalized') for k in COMPONENTS]
    return sum(v*COMPONENTS[k]['weight'] for k,v in zip(COMPONENTS,values)) if all(v is not None for v in values) else None


def pack():
    folder=Path(os.environ.get('TRACK_FAST_LADDER_DIR','fast-ladder-v1'))
    manifest=json.loads((folder/'manifest.json').read_text())
    if manifest['protocol']!=PROTOCOL:raise ValueError('Wrong ladder protocol')
    return folder,manifest


def likelihood(model,context,target):
    import torch
    prefix=list(context.encode()) or [32];continuation=list(target.encode());tokens=prefix+continuation
    if not continuation:return 0.0
    if len(tokens)-1>model.context_length:return model.score(context,target)[0]
    with torch.inference_mode():
        x=torch.tensor([tokens[:-1]],device=model._device)
        logits=model.model(x)[0].float().log_softmax(-1)
        indices=torch.arange(len(prefix)-1,len(tokens)-1,device=model._device)
        y=torch.tensor(continuation,device=model._device)
        return logits[indices,y].sum().item()


def evaluate(key,model,mode):
    folder,manifest=pack();raw=(folder/(key+'.jsonl')).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=manifest['components'][key]['sha256']:raise ValueError('Evaluation pack checksum mismatch')
    rows=[json.loads(line) for line in raw.decode().splitlines()]
    if mode=='smoke':rows=rows[:10]
    result={'protocol':PROTOCOL,'weight':COMPONENTS[key]['weight'],'sample_digest':hashlib.sha256(raw).hexdigest(),
            'source':manifest['sources'][key],'mode':mode}
    if key=='fast_lm':
        import torch
        data=rows[0]['text'].encode();data=data[:8192] if mode=='smoke' else data
        total=0.0;count=0
        with torch.inference_mode():
            for start in range(0,len(data),model.context_length):
                target=list(data[start:start+model.context_length])
                inputs=[data[start-1] if start else 32]+target[:-1]
                logits=model.model(torch.tensor([inputs],device=model._device))[0].float().log_softmax(-1)
                y=torch.tensor(target,device=model._device)
                total-=logits.gather(1,y[:,None]).sum().item();count+=len(target)
        nll=total/count;bpb=nll/math.log(2)
        return {**result,'samples':count,'unit':'UTF-8 bytes','nll':nll,'bpb':bpb,'normalized':1-bpb/8,
                'scoring':'non-overlapping context-length blocks, preceding byte prefix; every byte scored once'}
    margins=[];scaled=[];correct=[];probabilities=[]
    for row in rows:
        if key=='fast_arc':
            values=[likelihood(model,row['context'],c) for c in row['choices']]
            answer=row['answer'];best=max(values);p=math.exp(values[answer]-best)/sum(math.exp(v-best) for v in values)
            margins.append(values[answer]-max(v for i,v in enumerate(values) if i!=answer))
            probabilities.append(p);scaled.append((p-1/len(values))/(1-1/len(values)))
            correct.append(int(values[answer]>max(v for i,v in enumerate(values) if i!=answer)))
        else:
            contexts=[(row['context'],row['good'],row['bad'])]
            if key=='fast_ewok':contexts.append((row['context2'],row['bad'],row['good']))
            for context,good,bad in contexts:
                margin=likelihood(model,context,good)-likelihood(model,context,bad)
                margins.append(margin);correct.append(int(margin>0))
                bits=margin/(max(len(good.encode()),len(bad.encode()),1)*math.log(2))
                scaled.append(math.tanh(bits))
    return {**result,'samples':len(rows),'comparisons':len(margins),'accuracy':sum(correct)/len(correct),
            'mean_margin_nats':sum(margins)/len(margins),'normalized':sum(scaled)/len(scaled),
            'mean_correct_probability':sum(probabilities)/len(probabilities) if probabilities else None}
