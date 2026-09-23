"""Track-managed 149M token-ID shard trainer for a single RunPod GPU."""
import hashlib, math, os, time
from pathlib import Path
import torch
from torch.nn import functional as F
from qwen_model import Deep576_37L

def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def train(remote, manifest):
    if not torch.cuda.is_available(): raise RuntimeError('CUDA unavailable; refusing CPU fallback')
    cfg=manifest['config']; root=Path(os.environ.get('TRACK_DATASET_DIR','/runpod-volume/datasets')).resolve()
    shards=[]
    for item in cfg['tokenized_shards']:
        path=(root/item['path']).resolve()
        if root not in path.parents or not path.is_file(): raise RuntimeError('Invalid tokenized shard path')
        if digest(path)!=item['sha256']: raise RuntimeError('Tokenized shard SHA-256 mismatch')
        if path.stat().st_size != item['tokens']*4: raise RuntimeError('Tokenized shard must be uint32 IDs')
        shards.append(torch.from_file(str(path),shared=False,size=item['tokens'],dtype=torch.int32))
    model=Deep576_37L().cuda(); count=model.parameter_count()
    if count != cfg['parameters']: raise RuntimeError(f'Parameter mismatch: {count}')
    opt=torch.optim.AdamW(model.parameters(),lr=cfg['learning_rate'],betas=(.9,.95),weight_decay=.1)
    ctx=2048; batch=cfg['batch_size']; target=cfg['steps']; seen=0; started=time.monotonic(); last=started
    remote.progress(0,message=f'149M Qwen-style runner verified {len(shards)} tokenized shards and {count:,} parameters.',gpu=torch.cuda.get_device_name(0))
    for step in range(1,target+1):
        rows=[]
        for n in range(batch):
            s=shards[(step+n)%len(shards)]; start=torch.randint(0,len(s)-ctx-1,()).item(); rows.append(s[start:start+ctx+1])
        z=torch.stack(rows).cuda(non_blocking=True).long(); x,y=z[:,:-1],z[:,1:]
        opt.zero_grad(set_to_none=True)
        with torch.autocast('cuda',dtype=torch.bfloat16): loss=F.cross_entropy(model(x).reshape(-1,model.vocab_size),y.reshape(-1))
        if not torch.isfinite(loss): raise RuntimeError('Non-finite loss')
        loss.backward(); grad=torch.nn.utils.clip_grad_norm_(model.parameters(),1.0); opt.step(); seen+=x.numel()
        if step==1 or step%25==0 or step==target or time.monotonic()-last>=15:
            values={'train/loss':loss.item(),'train/learning_rate':opt.param_groups[0]['lr'],'throughput/tokens_sec':seen/max(.001,time.monotonic()-started),'training/tokens_seen':seen,'progress':100*step/target}
            if remote.progress(step,values):
                torch.save({'state_dict':model.state_dict(),'config':cfg},'model.pt')
                return 'cancelled',{'stop_reason':'cancelled','completed_steps':step,'tokens_seen':seen,'best_val_loss':loss.item(),'best_val_perplexity':math.exp(min(loss.item(),80))}
            last=time.monotonic()
    torch.save({'state_dict':model.state_dict(),'config':cfg},'model.pt')
    return 'finished',{'stop_reason':'step_limit','completed_steps':target,'tokens_seen':seen,'best_val_loss':loss.item(),'best_val_perplexity':math.exp(min(loss.item(),80))}
