"""Standalone CUDA worker shipped as a SHA-256 pinned bundle into DMPod 1.0."""
import contextlib
import hashlib
import json
import math
import os
import random
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests
import torch
from torch.nn import functional as F
from native_model import TinyTransformer
from lr_schedule import learning_rate_at
from corpus_files import split_files


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()


class Remote:
    def __init__(self):
        self.base=os.environ['TRACK_URL']+'/api/runner/'+os.environ['TRACK_RUN_ID']
        self.session=requests.Session()
        self.session.headers.update({'Authorization':'Bearer '+os.environ['TRACK_RUN_TOKEN']})
    def call(self,method,path,**kw):
        for attempt in range(6):
            try:
                r=self.session.request(method,self.base+path,timeout=(30,180),**kw)
                if r.status_code>=500:r.raise_for_status()
                if r.status_code not in (429,):r.raise_for_status();return r
            except requests.RequestException:
                if attempt==5:raise
            time.sleep(min(2**attempt,20))
        raise RuntimeError('Callback unavailable')
    def progress(self,step,values=None,message='',gpu=None):
        payload={'step':step,'values':values or {},'message':message,'gpu':gpu}
        with Path('metrics.jsonl').open('a') as f:f.write(json.dumps(payload)+'\n')
        if message:
            with Path('training.log').open('a') as f:f.write(message+'\n')
            print(message,flush=True)
        return self.call('POST','/progress',json=payload).json()['stop']
    def upload(self,name):
        digest=sha(name)
        for attempt in range(5):
            try:
                with open(name,'rb') as f:
                    r=self.session.put(self.base+'/artifacts/'+name,data=f,
                         headers={'X-Content-SHA256':digest,'Content-Type':'application/octet-stream'},timeout=(30,300))
                r.raise_for_status();assert r.json()['sha256']==digest
                return digest
            except Exception:
                if attempt==4:raise
                time.sleep(2**attempt)


def _holdout_split(source, seed, seen):
    """Whole-document content-hash holdout with cross-source dedup.

    Mirrors the studio trainer: split a source on blank-line document
    boundaries, assign each unique document to training or the seeded ~10%
    validation holdout by a hash of its content (so a document never spans
    train and eval and duplicates across sources are dropped), and fall back to
    a contiguous 90/10 byte split when a source has fewer than two documents.
    """
    documents=[d for d in source.split(b"\n\n") if d.strip()]
    unique=[];picked=set()
    for document in documents:
        digest=hashlib.sha256(document).hexdigest()
        if digest in seen or digest in picked:continue
        picked.add(digest)
        unique.append((digest,document))
    if len(unique)<2:
        cut=int(len(source)*0.9)
        return source[:cut],source[cut:]
    ordered=sorted(unique,key=lambda u:hashlib.sha256(f"{seed}:{u[0]}".encode()).hexdigest())
    holdout={digest for digest,_ in ordered[:max(1,len(ordered)//10)]}
    train,val=bytearray(),bytearray()
    for digest,document in unique:
        seen.add(digest)
        target=val if digest in holdout else train
        if target:target+=b"\n\n"
        target+=document
    return bytes(train),bytes(val)


def train(remote,manifest):
    if not torch.cuda.is_available():raise RuntimeError('CUDA unavailable; refusing CPU fallback on a GPU job')
    torch.set_num_threads(4);torch.manual_seed(manifest['config']['seed'])
    cfg=manifest['config'];rng=random.Random(cfg['seed']);device='cuda'
    deadline=datetime.fromisoformat(manifest['deadline']).timestamp()-120
    remote.progress(0,message='CUDA initialized; downloading and verifying selected datasets.',gpu=torch.cuda.get_device_name(0))
    sources=[];validation=[];holdout_seen=set()
    for d in cfg['mix']:
        vol=os.environ.get('TRACK_DATASET_DIR');vp=os.path.join(vol,d['id']) if vol else None
        source = Path(vp) if vp and os.path.exists(vp) else Path(d['id'] + '.source')
        downloaded = not (vp and os.path.exists(vp))
        if downloaded:
            with remote.call('GET','/datasets/'+d['id'],stream=True) as response, source.open('wb') as output:
                for chunk in response.iter_content(chunk_size=1024*1024): output.write(chunk)
        if sha(source)!=d['sha256']:raise RuntimeError('Dataset SHA-256 mismatch')
        train_path, val_path = Path(d['id']+'.train'), Path(d['id']+'.val')
        remote.progress(0,message='Preparing document holdout for '+d['name'])
        split_files(source,train_path,val_path,cfg['seed'],holdout_seen)
        sources.append(torch.from_file(str(train_path),shared=False,size=train_path.stat().st_size,dtype=torch.uint8))
        validation.append(torch.from_file(str(val_path),shared=False,size=val_path.stat().st_size,dtype=torch.uint8))
        if downloaded: source.unlink()
    model=TinyTransformer(**{k:cfg[k] for k in ('width','layers','heads','context_length')}).to(device)
    count=sum(p.numel() for p in model.parameters())
    if count!=cfg['parameters']:raise RuntimeError('Model parameter count differs from recipe')
    optimizer=torch.optim.AdamW(model.parameters(),lr=cfg['learning_rate'])
    use_bf16=torch.cuda.is_bf16_supported()
    def precision():return torch.autocast('cuda',dtype=torch.bfloat16) if use_bf16 else contextlib.nullcontext()
    weights=[d['weight'] for d in cfg['mix']]
    def batch(data,n,random_source,length):
        rows=[]
        for i in random_source.choices(range(len(data)),weights=weights,k=n):
            d=data[i];start=random_source.randrange(len(d)-length)
            rows.append(d[start:start+length+1])
        z=torch.stack(rows).to(device=device,dtype=torch.long)
        return z[:,:-1],z[:,1:]
    length=cfg['training_context_length']
    val_length=min(cfg['context_length'],min(len(d)-1 for d in validation))
    vrng=random.Random(cfg['seed']+1)
    vbatches=[batch(validation,8,vrng,val_length) for _ in range(4)]
    def validate():
        model.eval()
        with torch.no_grad(),precision():
            losses=[F.cross_entropy(model(x).reshape(-1,256),y.reshape(-1)).float().item() for x,y in vbatches]
        return sum(losses)/len(losses)
    torch.cuda.reset_peak_memory_stats()
    best=validate();best_step=0;best_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
    patience_best=best;stale=0;seen=0;step=0;state='finished';reason='step_limit';start=time.monotonic();last_report=start
    remote.progress(0,message=f'Training {count:,} parameters on {torch.cuda.get_device_name(0)}; budget {cfg["planned_training_tokens"]:,} byte tokens.')
    for step in range(1,cfg['steps']+1):
        if time.time()>deadline:state='cancelled';reason='time_limit';step-=1;break
        lr=learning_rate_at(cfg,step)
        for group in optimizer.param_groups:group["lr"]=lr
        model.train();optimizer.zero_grad(set_to_none=True)
        x,y=batch(sources,cfg['batch_size'],rng,length)
        with precision():loss=F.cross_entropy(model(x).reshape(-1,256),y.reshape(-1))
        if not torch.isfinite(loss):raise RuntimeError('Non-finite training loss')
        loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.0);optimizer.step();seen+=x.numel()
        # Keep validation and cancellation responsive, without a callback for each GPU batch.
        if step==1 or step%25==0 or step==cfg['steps'] or time.monotonic()-last_report>=15:
            val=validate()
            if not math.isfinite(val):raise RuntimeError('Non-finite validation loss')
            if val<best:
                best=val;best_step=step;best_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
            if val<patience_best-cfg.get('min_delta',.01):patience_best=val;stale=0
            else:stale+=1
            values={'gpu/peak_allocated_mb':torch.cuda.max_memory_allocated()/1e6,'gpu/peak_reserved_mb':torch.cuda.max_memory_reserved()/1e6,'train/learning_rate':lr,'train/loss':loss.item(),'val/loss':val,'val/perplexity':math.exp(min(val,80)),
                    'throughput/tokens_sec':seen/max(time.monotonic()-start,.001),'progress':100*step/cfg['steps'],'training/tokens_seen':seen}
            stop=remote.progress(step,values);last_report=time.monotonic()
            if stop:state='cancelled';reason='cancelled';break
            if cfg.get('early_stopping',True) and stale>=cfg.get('patience',20):reason='early_stopping';break
    torch.save({'format':'fabryka-transformer-v1','config':cfg,'state_dict':best_state,'best_step':best_step,'best_val_loss':best},'model.pt')
    result={'stop_reason':reason,'completed_steps':step,'tokens_seen':seen,'best_step':best_step,
            'best_val_loss':best,'best_val_perplexity':math.exp(min(best,80)),'checkpoint_selection':'lowest_validation_loss',
            'peak_allocated_mb':torch.cuda.max_memory_allocated()/1e6,'peak_reserved_mb':torch.cuda.max_memory_reserved()/1e6,
            'gpu':torch.cuda.get_device_name(0),'torch':torch.__version__,'cuda':torch.version.cuda,'precision':'bf16' if use_bf16 else 'fp32'}
    remote.progress(step,message=f'Training ended: {reason}. Synchronizing checkpoint, metrics and recipe.')
    return state,result


def main():
    remote=Remote();state='failed';result={};error=''
    for name in ('training.log','metrics.jsonl'):Path(name).write_text('')
    Path('recipe.json').write_text('{}')
    try:
        manifest=remote.call('GET','/manifest').json();Path('recipe.json').write_text(json.dumps(manifest,indent=2))
        state,result=train(remote,manifest)
    except Exception as exc:
        error=f'{type(exc).__name__}: {str(exc)[:500]}'
        # Exception text has no credentials: request URLs contain run IDs only.
        with Path('training.log').open('a') as f:f.write(traceback.format_exc())
        print(error,flush=True)
    Path('result.json').write_text(json.dumps({'state':state,'result':result,'error':error},indent=2))
    names=['recipe.json','metrics.jsonl','training.log','result.json']
    if Path('model.pt').exists():names.append('model.pt')
    files={name:remote.upload(name) for name in names}
    response=remote.call('POST','/complete',json={'state':state,'result':result,'files':files,'error':error}).json()
    assert response['verified']
    print('Artifact hashes verified by Track. Controller will terminate this pod.',flush=True)
    # Stay available until deletion; process exit is not equivalent to stopping billing.
    time.sleep(180)


if __name__=='__main__':main()
