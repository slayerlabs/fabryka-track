"""Subprocess entry point: pinned dataset revisions, official task definitions."""
import hashlib
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import version

import torch
from huggingface_hub import HfApi
from lm_eval import simple_evaluate
from lm_eval.tasks import TaskManager
from lm_eval.tasks._yaml_loader import load_yaml
from sqlalchemy import update

from .benchmark_model import ByteCheckpointLM
from .benchmarks import TASKS
from .database import SessionLocal
from .hf_publish import checkpoint_path
from .models import BenchmarkEvaluation, Run
from .leaderboard_suite import DATA, evaluate as evaluate_continuations, index_result


def configure_cuda_budget(device):
    """Optional per-child PyTorch allocation cap; CUDA context memory is extra."""
    value=os.environ.get('TRACK_BENCHMARK_MEMORY_LIMIT_MB')
    if not device.startswith('cuda') or value is None:return {}
    limit=int(value)
    total=torch.cuda.get_device_properties(device).total_memory
    if not 0<limit*1024**2<=total:raise ValueError('Invalid benchmark CUDA memory limit')
    torch.cuda.set_per_process_memory_fraction(limit*1024**2/total,device=device)
    return {'cuda_allocator_limit_mb':limit}


def persist(eid, **values):
    with SessionLocal() as db:
        n=db.execute(update(BenchmarkEvaluation).where(BenchmarkEvaluation.id==eid,
            BenchmarkEvaluation.status.in_(['queued','running'])).values(**values)).rowcount
        db.commit()
    if not n:raise SystemExit(0)


def summarize(name, output):
    leaf_names=list(output['samples'])
    samples=[x for leaf in leaf_names for x in output['samples'][leaf]]
    # Macro-average BLiMP's 67 phenomena; other benchmarks have one leaf task.
    accuracies=[output['results'][leaf]['acc,none'] for leaf in leaf_names]
    accuracy=sum(accuracies)/len(accuracies)
    baseline=None if name=='lambada_openai' else sum(1/len(x['resps']) for x in samples)/len(samples)
    normalized=(accuracy-baseline)/(1-baseline) if baseline is not None else None
    per_leaf={leaf:{'accuracy':output['results'][leaf]['acc,none'],
                    'samples':len(output['samples'][leaf])} for leaf in leaf_names}
    row={'accuracy':accuracy,'random_baseline':baseline,'normalized':normalized,
         'samples':len(samples),'subtasks':per_leaf}
    if len(leaf_names)==1:
        results=output['results'][leaf_names[0]]
        row['acc_norm']=results.get('acc_norm,none')
        row['stderr']=results.get('acc_stderr,none') if isinstance(results.get('acc_stderr,none'),(int,float)) else None
        row['perplexity']=results.get('perplexity,none')
    row['sample_digest']=hashlib.sha256('\n'.join(str((x['doc_id'],x['doc_hash'],x['prompt_hash'],x['target_hash'])) for x in samples).encode()).hexdigest()
    return row


def run(eid, job=None, reporter=None):
    from pathlib import Path
    torch.set_num_threads(1)
    save = reporter or (lambda **values: persist(eid, **values))
    if job is None:
        with SessionLocal() as db:
            row=db.get(BenchmarkEvaluation,eid)
            if not row or row.status not in ('queued','running'):return
            path=checkpoint_path(db,db.get(Run,row.run_id))
            job={'provenance':dict(row.provenance),'tasks':list(row.tasks),'mode':row.mode,'results':dict(row.results)}
    else:
        path=Path(job['checkpoint'])
    provenance=dict(job['provenance']);tasks=job['tasks'];mode=job['mode']
    if hashlib.sha256(path.read_bytes()).hexdigest()!=provenance['checkpoint_sha256']:
        raise ValueError('Checkpoint changed')
    payload=torch.load(path,map_location='cpu',weights_only=True)
    cfg=payload['config'];best_step=payload.get('best_step')
    length=min(cfg['context_length'],min(int(d['bytes']*.9)-1 for d in cfg['mix']))
    tokens=best_step*cfg['batch_size']*length if best_step is not None else None
    device=job.get('device','cpu')
    for key in ('cuda_allocator_limit_mb','cuda_peak_allocated_mb','cuda_peak_reserved_mb'):
        provenance.pop(key,None)
    if device.startswith('cuda'):
        torch.backends.cuda.matmul.allow_tf32=False
        torch.backends.cudnn.allow_tf32=False
        provenance.update(configure_cuda_budget(device))
    provenance.update(harness_version=version('lm-eval'),torch_version=torch.__version__,
        checkpoint_step=best_step,training_tokens=tokens,token_unit='utf8_bytes',
        context_length=cfg['context_length'],parameters=cfg['parameters'],
        approximate_training_flops=6*cfg['parameters']*tokens if tokens is not None else None,
        flops_method='6*N*D estimate; excludes evaluation',
        empty_context_prefix='space byte (32)',scoring='every continuation byte, maximal sliding context',
        validation_loss=payload.get('best_val_loss'),dataset_revisions=provenance.get('dataset_revisions',{}),
        device=device,gpu=torch.cuda.get_device_name() if device.startswith('cuda') else None,
        scoring_implementation='bounded-fused-prefix-v2')
    save(status='running',provenance=provenance)
    model=ByteCheckpointLM(path,device=device);manager=TaskManager();api=HfApi();results=dict(job.get('results',{}));failures=[]
    for name in tasks:
        if name in results and not results[name].get('error'):continue
        save(current_task=name)
        task_started=time.monotonic()
        try:
            if name in DATA or name=='int_index':
                results[name]=index_result(results) if name=='int_index' else evaluate_continuations(name,model,mode)
                results[name]['elapsed_seconds']=time.monotonic()-task_started
                provenance['dataset_revisions'].update(results[name]['dataset_revisions'])
                save(results=results,provenance=provenance)
                continue
            if name.startswith('pl_'):
                from .fast_pl_ladder import evaluate as evaluate_pl
                results[name]=evaluate_pl(name,model,mode)
                save(results=results,provenance=provenance)
                continue
            if name.startswith('fast_'):
                from .fast_ladder import evaluate
                results[name]=evaluate(name,model,mode)
                save(results=results,provenance=provenance)
                continue
            if name == 'multiblimp_polish':
                from datasets import load_dataset
                revision = provenance['dataset_revisions'].get('jumelet/multiblimp') or api.dataset_info('jumelet/multiblimp').sha
                rows = load_dataset('jumelet/multiblimp', 'pol', split='train', revision=revision,
                                    streaming=True)
                correct = total = 0
                for item in rows:
                    good = model.score('', item['sen'])[0]
                    bad = model.score('', item['wrong_sen'])[0]
                    correct += int(good > bad); total += 1
                    if mode == 'smoke' and total >= 100: break
                results[name] = {'accuracy': correct / total if total else None,
                                 'random_baseline': .5, 'normalized': (correct / total - .5) / .5 if total else None,
                                 'samples': total, 'language': 'pol', 'dataset_revisions': {'jumelet/multiblimp': revision},
                                 'phenomena': 'agreement minimal pairs', 'split': 'train'}
                provenance['dataset_revisions'] = {**provenance['dataset_revisions'], 'jumelet/multiblimp': revision}
                save(results=results, provenance=provenance)
                continue
            entry=manager.task_index[name]
            names=entry.cfg['task'] if name=='blimp' else [name]
            configs=[];revisions={}
            for leaf in names:
                config=load_yaml(manager.task_index[leaf].yaml_path,resolve_func=True)
                repo=config['dataset_path']
                if repo not in revisions:revisions[repo]=provenance['dataset_revisions'].get(repo) or api.dataset_info(repo).sha
                config['dataset_kwargs']={**(config.get('dataset_kwargs') or {}),'revision':revisions[repo]}
                configs.append(config)
            provenance['dataset_revisions']={**provenance['dataset_revisions'],**revisions}
            save(provenance=provenance)
            output=simple_evaluate(model=model,tasks=configs,num_fewshot=0,
                limit=10 if mode=='smoke' else None,bootstrap_iters=0,log_samples=True,
                random_seed=42,numpy_random_seed=42,torch_random_seed=42,fewshot_random_seed=42,
                task_manager=manager)
            results[name]=summarize(name,output)
            results[name]['dataset_revisions']=revisions
            results[name]['task_versions']=output['versions']
            results[name]['splits']={k:v.get('test_split') or v.get('validation_split') for k,v in output['configs'].items()}
            results[name]['elapsed_seconds']=time.monotonic()-task_started
        except Exception as exc:
            failures.append(name)
            import traceback; traceback.print_exc(file=sys.stderr)
            results[name]={'error':('GPU memory exhausted even at the minimum evaluation batch size. Retry on a worker with more free GPU memory.' if isinstance(exc,torch.OutOfMemoryError) else 'Dataset loading or evaluation failed ('+type(exc).__name__+'). Retry after checking dataset availability.')}
            print(name,type(exc).__name__,str(exc),file=sys.stderr)
        provenance.update(context_limited_requests=job['provenance'].get('context_limited_requests',0)+model.truncated_requests,total_requests=job['provenance'].get('total_requests',0)+model.total_requests)
        save(results=results,provenance=provenance)
    if device.startswith('cuda'):
        provenance.update(cuda_peak_allocated_mb=torch.cuda.max_memory_allocated(device)/1024**2,
                          cuda_peak_reserved_mb=torch.cuda.max_memory_reserved(device)/1024**2)
    save(status='failed' if failures else 'finished',current_task=None,provenance=provenance,
            error='Failed tasks: '+', '.join(failures) if failures else None,
            ended_at=datetime.now(timezone.utc))


if __name__=='__main__':
    try:run(sys.argv[1])
    except Exception as exc:
        persist(sys.argv[1],status='failed',error='Checkpoint evaluation failed ('+type(exc).__name__+').',ended_at=datetime.now(timezone.utc))
        raise
