"""Subprocess entry point: pinned dataset revisions, official task definitions."""
import hashlib
import json
import math
import sys
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


def run(eid):
    torch.set_num_threads(1)
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,eid)
        if not row or row.status not in ('queued','running'):return
        parent=db.get(Run,row.run_id)
        path=checkpoint_path(db,parent)
        provenance=dict(row.provenance); tasks=list(row.tasks); mode=row.mode
        if hashlib.sha256(path.read_bytes()).hexdigest()!=provenance['checkpoint_sha256']:
            raise ValueError('Checkpoint changed')
        payload=torch.load(path,map_location='cpu',weights_only=True)
        cfg=payload['config']; best_step=payload.get('best_step')
        length=min(cfg['context_length'],min(int(d['bytes']*.9)-1 for d in cfg['mix']))
        tokens=best_step*cfg['batch_size']*length if best_step is not None else None
        provenance.update(harness_version=version('lm-eval'),torch_version=torch.__version__,
            checkpoint_step=best_step,training_tokens=tokens,token_unit='utf8_bytes',
            context_length=cfg['context_length'],parameters=cfg['parameters'],
            approximate_training_flops=6*cfg['parameters']*tokens if tokens is not None else None,
            flops_method='6*N*D estimate; excludes evaluation',
            empty_context_prefix='space byte (32)',scoring='every continuation byte, maximal sliding context',
            validation_loss=payload.get('best_val_loss'),dataset_revisions={})
    persist(eid,status='running',provenance=provenance)
    model=ByteCheckpointLM(path); manager=TaskManager(); api=HfApi(); results={}; failures=[]
    for name in tasks:
        persist(eid,current_task=name)
        try:
            entry=manager.task_index[name]
            names=entry.cfg['task'] if name=='blimp' else [name]
            configs=[];revisions={}
            for leaf in names:
                config=load_yaml(manager.task_index[leaf].yaml_path,resolve_func=True)
                repo=config['dataset_path']
                if repo not in revisions:revisions[repo]=api.dataset_info(repo).sha
                config['dataset_kwargs']={**(config.get('dataset_kwargs') or {}),'revision':revisions[repo]}
                configs.append(config)
            provenance['dataset_revisions']={**provenance['dataset_revisions'],**revisions}
            persist(eid,provenance=provenance)
            output=simple_evaluate(model=model,tasks=configs,num_fewshot=0,
                limit=10 if mode=='smoke' else None,bootstrap_iters=0,log_samples=True,
                random_seed=42,numpy_random_seed=42,torch_random_seed=42,fewshot_random_seed=42,
                task_manager=manager)
            results[name]=summarize(name,output)
            results[name]['dataset_revisions']=revisions
            results[name]['task_versions']=output['versions']
            results[name]['splits']={k:v.get('test_split') or v.get('validation_split') for k,v in output['configs'].items()}
        except Exception as exc:
            failures.append(name)
            results[name]={'error':'Dataset loading or evaluation failed ('+type(exc).__name__+'). Retry after checking dataset availability.'}
            print(name,type(exc).__name__,str(exc),file=sys.stderr)
        provenance.update(context_limited_requests=model.truncated_requests,total_requests=model.total_requests)
        persist(eid,results=results,provenance=provenance)
    persist(eid,status='failed' if failures else 'finished',current_task=None,
            error='Failed tasks: '+', '.join(failures) if failures else None,
            ended_at=datetime.now(timezone.utc))


if __name__=='__main__':
    try:run(sys.argv[1])
    except Exception as exc:
        persist(sys.argv[1],status='failed',error='Checkpoint evaluation failed ('+type(exc).__name__+').',ended_at=datetime.now(timezone.utc))
        raise
