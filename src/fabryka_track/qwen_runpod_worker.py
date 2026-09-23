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
    if not torch.cuda.is_bf16_supported(): raise RuntimeError('This 149M recipe requires a BF16-capable GPU')
    cfg=manifest['config']; root=Path(os.environ.get('TRACK_DATASET_DIR','/runpod-volume/datasets')).resolve()
    shards={'train': [], 'validation': []}
    for item in cfg['tokenized_shards']:
        path=(root/item['path']).resolve()
        if root not in path.parents or not path.is_file(): raise RuntimeError('Invalid tokenized shard path')
        if digest(path)!=item['sha256']: raise RuntimeError('Tokenized shard SHA-256 mismatch')
        if path.stat().st_size != item['tokens']*4: raise RuntimeError('Tokenized shard must be uint32 IDs')
        shards[item['split']].append(torch.from_file(str(path),shared=False,size=item['tokens'],dtype=torch.int32))
    if not shards['train'] or not shards['validation']: raise RuntimeError('Separate train and validation shards are required')
    torch.manual_seed(cfg['seed'])
    model=Deep576_37L().cuda(); count=model.parameter_count()
    if count != cfg['parameters']: raise RuntimeError(f'Parameter mismatch: {count}')
    opt=torch.optim.AdamW(model.parameters(),lr=cfg['learning_rate'],betas=(.9,.95),weight_decay=.1)
    ctx=2048; batch_size=cfg['batch_size']; target=cfg['steps']; seen=0; started=time.monotonic(); last=started
    checkpoint_every=max(1, target // 5)
    remote.progress(0,message=f'149M Qwen-style runner verified {len(shards["train"])} train and {len(shards["validation"])} validation shards; {count:,} parameters.',gpu=torch.cuda.get_device_name(0))
    def batch(source, batch_size, offset=0):
        rows=[]
        for n in range(batch_size):
            shard=source[(offset+n) % len(source)]
            start=torch.randint(0,len(shard)-ctx-1,()).item()
            rows.append(shard[start:start+ctx+1])
        z=torch.stack(rows).cuda(non_blocking=True).long()
        return z[:,:-1], z[:,1:]
    val_batches=[batch(shards['validation'], min(batch_size, 4), offset=n) for n in range(4)]
    def validate():
        model.eval()
        with torch.no_grad(), torch.autocast('cuda',dtype=torch.bfloat16):
            losses=[F.cross_entropy(model(x).reshape(-1,model.vocab_size),y.reshape(-1)).float().item() for x,y in val_batches]
        model.train()
        return sum(losses) / len(losses)
    best=validate(); best_step=0; best_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
    for step in range(1,target+1):
        x,y=batch(shards['train'], batch_size, offset=step)
        opt.zero_grad(set_to_none=True)
        with torch.autocast('cuda',dtype=torch.bfloat16): loss=F.cross_entropy(model(x).reshape(-1,model.vocab_size),y.reshape(-1))
        if not torch.isfinite(loss): raise RuntimeError('Non-finite loss')
        loss.backward(); grad=torch.nn.utils.clip_grad_norm_(model.parameters(),1.0); opt.step(); seen+=x.numel()
        if step==1 or step%25==0 or step==target or time.monotonic()-last>=15:
            val=validate()
            if val < best:
                best, best_step=val, step
                best_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
            values={'gpu/peak_allocated_mb':torch.cuda.max_memory_allocated()/1e6,'gpu/peak_reserved_mb':torch.cuda.max_memory_reserved()/1e6,'train/loss':loss.item(),'train/learning_rate':opt.param_groups[0]['lr'],'val/loss':val,'val/perplexity':math.exp(min(val,80)),'throughput/tokens_sec':seen/max(.001,time.monotonic()-started),'training/tokens_seen':seen,'progress':100*step/target}
            if remote.progress(step,values):
                torch.save({'format':'fabryka-qwen149m-v1','state_dict':best_state,'config':cfg,'best_step':best_step,'best_val_loss':best},'model.pt')
                return 'cancelled',{'stop_reason':'cancelled','completed_steps':step,'tokens_seen':seen,'best_step':best_step,'best_val_loss':best,'best_val_perplexity':math.exp(min(best,80))}
            last=time.monotonic()
        if step % checkpoint_every == 0 and step != target:
            torch.save({'format':'fabryka-qwen149m-v1','config':cfg,'state_dict':model.state_dict(),'optimizer_state_dict':opt.state_dict(),'step':step},f'checkpoint-{step}.pt')
            remote.upload(f'checkpoint-{step}.pt')
    torch.save({'format':'fabryka-qwen149m-v1','state_dict':best_state,'config':cfg,'best_step':best_step,'best_val_loss':best},'model.pt')
    return 'finished',{'stop_reason':'step_limit','completed_steps':target,'tokens_seen':seen,'best_step':best_step,'best_val_loss':best,'best_val_perplexity':math.exp(min(best,80))}
