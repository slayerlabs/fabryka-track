"""Owner-requested TinyLM evaluations, isolated from the web/training process."""
import hashlib
import importlib.util
import math
import os
import signal
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func

from .accounts import require_user, current_user, owned_run
from .database import SessionLocal, session_scope
from .hf_publish import checkpoint_path
from .models import Account, BenchmarkEvaluation, Run, RunLog

router = APIRouter(prefix='/api')
from .fast_ladder import COMPONENTS, PROTOCOL as FAST_PROTOCOL, fast_score
from .fast_pl_ladder import pl_score

PROTOCOL = 'tinylm-en-v1-byte-sliding'
CORE = ['sciq','arc_easy','piqa','hellaswag','blimp']
SUITES = {'piqa':['piqa'], 'core':CORE, 'tinylm':CORE+['lambada_openai'],
          'extended':CORE+['lambada_openai','winogrande','boolq'],
          'polish': ['multiblimp_polish'], 'fast':[k for k in COMPONENTS if k!='fast_ewok'], 'fast_pl':['pl_lm','pl_multiblimp','pl_induction']}
TASKS = {
    'sciq': ('SciQ','allenai/sciq'), 'arc_easy': ('ARC-Easy','allenai/ai2_arc'),
    'piqa': ('PIQA','baber/piqa'), 'hellaswag': ('HellaSwag','Rowan/hellaswag'),
    'blimp': ('BLiMP','nyu-mll/blimp'), 'lambada_openai': ('LAMBADA','EleutherAI/lambada_openai'),
    'winogrande': ('WinoGrande','allenai/winogrande'), 'boolq': ('BoolQ','aps/super_glue'),
    'multiblimp_polish': ('MultiBLiMP · Polish','jumelet/multiblimp'),
}
TIERS = [
    {'id':'tokenizer','gate':'Tokenizer gate','metric':'Polish fertility, UTF-8 roundtrip, bits-per-byte','useful_from':'before 1M'},
    {'id':'loss','gate':'Held-out loss','metric':'bits-per-byte','useful_from':'1M+'},
    {'id':'multiblimp','gate':'MultiBLiMP Polish','metric':'minimal-pair accuracy','useful_from':'5M+'},
    {'id':'induction','gate':'Induction / copy','metric':'loss gap (token 500 vs 50), copy accuracy','useful_from':'2 layers'},
    {'id':'generation','gate':'Generation','metric':'distinct-n and rubric samples','useful_from':'5–30M'},
    {'id':'sciq_piqa','gate':'SciQ + PIQA','metric':'chance-normalized accuracy and correct probability','useful_from':'30–70M'},
    {'id':'lambada','gate':'LAMBADA Polish','metric':'target log-probability and accuracy','useful_from':'70M+'},
    {'id':'arc_easy','gate':'ARC-Easy','metric':'chance-normalized accuracy and correct probability','useful_from':'70–150M'},
    {'id':'hellaswag','gate':'HellaSwag','metric':'correct probability; accuracy only at larger scale','useful_from':'30M+'},
    {'id':'synthetic_facts','gate':'Injected synthetic facts','metric':'recall by exposure count','useful_from':'capacity dependent'},
]
lock = threading.Lock()
processes = {}
QUEUE_STOP = threading.Event()
QUEUE_THREAD = None


def tiny_score(results):
    """Equal weight per task; negative scores retained; no invented LAMBADA baseline."""
    values = [results.get(task,{}).get('normalized') for task in CORE]
    return sum(values)/len(values) if all(v is not None for v in values) else None


def serialize(row, session=None):
    position=None
    if session is not None and row.status=='queued':
        position=1+session.scalar(select(func.count()).select_from(BenchmarkEvaluation).where(
            BenchmarkEvaluation.status=='queued',
            (BenchmarkEvaluation.created_at<row.created_at) | ((BenchmarkEvaluation.created_at==row.created_at)&(BenchmarkEvaluation.id<row.id))))
    return {k:getattr(row,k) for k in ('id','run_id','status','mode','tasks','results','provenance','current_task','error','created_at','ended_at')} | {'tiny_score':tiny_score(row.results), 'protocol':row.provenance.get('protocol',PROTOCOL), 'fast_score':fast_score(row.results), 'pl_score':pl_score(row.results), 'queue_position':position}


def auto_benchmark_summary(session, run):
    """Headline of a run's automatic benchmark for the leaderboard: suite, human label, state, and one score.
    Single-task suites (polish, piqa) report the task accuracy; multi-task core reports the chance-normalized TinyScore."""
    eid = (run.metadata_ or {}).get('auto_benchmark_id')
    if not eid:
        return None
    ev = session.get(BenchmarkEvaluation, eid)
    if ev is None:
        return None
    results = ev.results or {}
    tasks = ev.tasks or []
    if 'multiblimp_polish' in tasks:
        cell = results.get('multiblimp_polish') or {}
        label, score, is_percent = 'Polish MultiBLiMP', (None if cell.get('error') else cell.get('accuracy')), True
    elif len(tasks) == 1:
        cell = results.get(tasks[0]) or {}
        label, score, is_percent = TASKS.get(tasks[0], (tasks[0],))[0], (None if cell.get('error') else cell.get('accuracy')), True
    else:
        label, score, is_percent = 'TinyScore', tiny_score(results), False
    return {'suite': run.config.get('auto_benchmark_suite'), 'label': label, 'state': ev.status, 'score': score, 'is_percent': is_percent}


@router.get('/benchmarks/catalog')
def catalog():
    return {'protocol':PROTOCOL, 'available':importlib.util.find_spec('lm_eval') is not None,
            'tasks':[{'id':k,'name':v[0],'url':'https://huggingface.co/datasets/'+v[1]} for k,v in TASKS.items()],
            'core':CORE,'suites':SUITES,'tiers':TIERS,'fast_ladder':COMPONENTS}


def visible_run(session,run_id,user):
    run=session.get(Run,run_id)
    if run and ((user and run.owner_id==user.id) or (run.is_public and run.state=='finished')):
        return run
    raise HTTPException(404 if user else 401,'Run not found')


@router.get('/runs/{run_id}/benchmarks')
def history(run_id:str,user=Depends(current_user),session=Depends(session_scope)):
    visible_run(session,run_id,user)
    return [serialize(row,session) for row in session.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id==run_id).order_by(BenchmarkEvaluation.created_at.desc()))]


class EvaluationInput(BaseModel):
    suite: Literal['core','tinylm','extended','polish','fast','piqa','fast_pl'] = 'tinylm'
    mode: Literal['smoke','full'] = 'smoke'


@router.post('/runs/{run_id}/benchmarks',status_code=202)
def start(run_id:str,body:EvaluationInput,user=Depends(require_user),session=Depends(session_scope)):
    run=owned_run(session,run_id,user)
    path=checkpoint_path(session,run)
    from .benchmark_remote import runners
    if importlib.util.find_spec('lm_eval') is None and not runners():
        raise HTTPException(503,'The benchmark worker is not installed on this server.')
    with lock:
        active=session.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id==run_id, BenchmarkEvaluation.status.in_(['queued','running'])))
        if active:
            raise HTTPException(409,'This run already has a queued or running evaluation.')
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        tasks=SUITES[body.suite]
        protocol=FAST_PROTOCOL if body.suite=='fast' else PROTOCOL
        previous=list(session.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id==run_id,
            BenchmarkEvaluation.mode==body.mode).order_by(BenchmarkEvaluation.created_at.desc())))
        compatible=[r for r in previous if r.provenance.get('checkpoint_sha256')==digest and
                    r.provenance.get('protocol')==protocol and r.provenance.get('seed')==42 and
                    r.provenance.get('fewshot')==0 and r.provenance.get('limit_per_subtask')==(10 if body.mode=='smoke' else None)]
        # Reuse one coherent pinned evaluation; never mix smoke/full measurements.
        source=max(compatible,key=lambda r:sum(k in r.results and not r.results[k].get('error') for k in tasks),default=None)
        completed={k:v for k,v in (source.results.items() if source else []) if k in tasks and not v.get('error')}
        if source and set(source.tasks)==set(tasks) and len(completed)==len(tasks):
            return serialize(source,session)
        if session.scalar(select(func.count()).select_from(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='queued'))>=20:
            raise HTTPException(409,'The benchmark queue is full (20 waiting evaluations).')
        if source and set(source.tasks)==set(tasks):
            row=source
            if live_worker_pid(row):raise HTTPException(409,'Previous worker is still stopping. Retry shortly.')
            row.status='queued';row.current_task=None;row.error=None;row.ended_at=None
            row.provenance={**{k:v for k,v in row.provenance.items() if k not in ('runner','lease','heartbeat','worker_pid')},
                            'resumed_at':datetime.now(timezone.utc).isoformat(),'reused_tasks':list(completed)}
            row.results=completed
        else:
            provenance={k:v for k,v in (source.provenance.items() if source else []) if k not in ('runner','lease','heartbeat','worker_pid')}
            provenance.update(checkpoint_sha256=digest,protocol=protocol,fewshot=0,seed=42,
                              limit_per_subtask=10 if body.mode=='smoke' else None,reused_tasks=list(completed))
            if source:provenance['reused_from_evaluation']=source.id
            row=BenchmarkEvaluation(run_id=run.id,mode=body.mode,tasks=tasks,results=completed,provenance=provenance,
                                    status='finished' if len(completed)==len(tasks) else 'queued',
                                    ended_at=datetime.now(timezone.utc) if len(completed)==len(tasks) else None)
            session.add(row)
        session.commit();session.refresh(row)
    return serialize(row,session)


@router.post('/runs/{run_id}/benchmarks/{evaluation_id}/cancel')
def cancel(run_id:str,evaluation_id:str,user=Depends(require_user),session=Depends(session_scope)):
    owned_run(session,run_id,user)
    with lock:
        row=session.get(BenchmarkEvaluation,evaluation_id)
        if not row or row.run_id!=run_id:raise HTTPException(404,'Evaluation not found')
        if row.status not in ('queued','running'):raise HTTPException(409,'Evaluation already ended')
        pid=live_worker_pid(row)
        row.status='cancelled';row.ended_at=datetime.now(timezone.utc);session.commit()
        process=processes.get(row.id)
        if process and process.poll() is None:process.terminate()
        elif pid:
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
    return serialize(row)


def supervise(evaluation_id):
    claimed=False
    try:
        with lock, SessionLocal() as db:
            row=db.get(BenchmarkEvaluation,evaluation_id)
            if not row or row.status!='queued':return
            if db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='running')):return
            row.status='running';db.commit();claimed=True
            env=os.environ.copy();env.update(OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',TOKENIZERS_PARALLELISM='false')
            # No user-controlled command or model code is executed.
            process=subprocess.Popen([sys.executable,'-m','fabryka_track.benchmark_worker',evaluation_id],env=env,
                                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            processes[evaluation_id]=process
            row.provenance={**row.provenance,"worker_pid":process.pid};db.commit()
        try:process.wait(timeout=7200)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
    finally:
        if claimed:
            with lock, SessionLocal() as db:
                processes.pop(evaluation_id,None)
                row=db.get(BenchmarkEvaluation,evaluation_id)
                if row and row.status in ('queued','running'):
                    row.status='failed';row.error='Evaluation worker stopped or exceeded its two-hour limit. Retry the evaluation.'
                    row.ended_at=datetime.now(timezone.utc);db.commit()

def worker_pids():
    found={}
    for process in Path('/proc').glob('[0-9]*'):
        try:args=(process/'cmdline').read_bytes().split(b'\0')
        except OSError:continue
        if b'fabryka_track.benchmark_worker' in args:
            i=args.index(b'fabryka_track.benchmark_worker')
            if len(args)>i+1:found[args[i+1].decode(errors='replace')]=int(process.name)
    for eid,process in list(processes.items()):
        if process.poll() is None:found[eid]=process.pid
    return found


def live_worker_pid(row):
    return worker_pids().get(row.id)


def recover_evaluations():
    # Queued jobs survive restarts; occupied external workers retain their slot.
    with lock, SessionLocal() as db:
        alive=worker_pids()
        for row in db.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status.in_(['queued','running']))):
            if row.id in alive:
                row.status='running'
                continue
            if row.status=='queued':continue
            if row.provenance.get('runner'):
                import time
                if time.time()-row.provenance.get('heartbeat',0)<180:continue
                row.status='queued';row.current_task=None;row.error=None
                row.provenance={k:v for k,v in row.provenance.items() if k not in ('runner','lease','heartbeat')}
                continue
            row.status='failed';row.error='Evaluation worker stopped. Partial results were retained; enqueue a new evaluation to retry.'
            row.ended_at=datetime.now(timezone.utc)
        db.commit()


def enqueue_automatic():
    """Durable reconciliation: enqueue once, only after verified completion.

    The run marker and existing job lookup make restart/repeated ticks safe.
    Full queues defer work; benchmark failure never changes training status.
    """
    with SessionLocal() as db:
        pending = list(db.scalars(select(Run).where(Run.state == 'finished',
            Run.config['auto_benchmark'].as_boolean() == True,
            Run.metadata_['auto_benchmark_id'].as_string().is_(None)).order_by(Run.ended_at).limit(20)))
        for run in pending:
            suite = run.config.get('auto_benchmark_suite', 'piqa')
            if suite not in ('piqa', 'core', 'polish', 'fast_pl'): continue
            owner = db.get(Account, run.owner_id) if run.owner_id else None
            if not owner: continue
            existing = db.scalars(select(BenchmarkEvaluation).where(
                BenchmarkEvaluation.run_id == run.id,
                BenchmarkEvaluation.mode == 'full').order_by(BenchmarkEvaluation.created_at.desc())).all()
            match = next((row for row in existing if set(row.tasks) == set(SUITES[suite])), None)
            try:
                eid = match.id if match else start(run.id, EvaluationInput(suite=suite, mode='full'), user=owner, session=db)['id']
            except HTTPException as exc:
                if exc.status_code in (409, 503): continue
                run.metadata_ = {**run.metadata_, 'auto_benchmark_error': exc.detail}
                db.commit(); continue
            run.metadata_ = {**run.metadata_, 'auto_benchmark_id': eid}
            db.add(RunLog(run_id=run.id, message=f'Automatic full {suite} benchmark linked to the background evaluation queue.'))
            db.commit()


def queue_tick():
    recover_evaluations()
    enqueue_automatic()
    from .benchmark_remote import runners
    if runners():return
    with lock, SessionLocal() as db:
        # Includes a cancelled worker which has not exited yet.
        if worker_pids() or processes:return
        if db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='running')):return
        row=db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='queued').order_by(BenchmarkEvaluation.created_at,BenchmarkEvaluation.id))
        if row:threading.Thread(target=supervise,args=(row.id,),daemon=True).start()


def start_queue():
    global QUEUE_THREAD
    QUEUE_STOP.clear()
    def loop():
        while not QUEUE_STOP.wait(3):
            try:queue_tick()
            except Exception:
                # A transient database/provider failure must not discard queued work.
                import logging
                logging.getLogger(__name__).exception('Benchmark queue tick failed')
    QUEUE_THREAD=threading.Thread(target=loop,daemon=True,name='benchmark-queue');QUEUE_THREAD.start()


def stop_queue():
    QUEUE_STOP.set()
    if QUEUE_THREAD:QUEUE_THREAD.join(timeout=5)


@router.get('/benchmarks/queue')
def queue(user=Depends(require_user),session=Depends(session_scope)):
    rows=session.scalars(select(BenchmarkEvaluation).join(Run).where(Run.owner_id==user.id,
        BenchmarkEvaluation.status.in_(['queued','running'])).order_by(BenchmarkEvaluation.created_at,BenchmarkEvaluation.id))
    return {'items':[serialize(row,session)|{'run_name':session.get(Run,row.run_id).name} for row in rows],
            'running':session.scalar(select(func.count()).select_from(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='running')),
            'waiting':session.scalar(select(func.count()).select_from(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='queued'))}


@router.get('/benchmarks/evaluations')
def evaluations(limit:int=Query(50,ge=1,le=100),offset:int=Query(0,ge=0),user=Depends(require_user),session=Depends(session_scope)):
    query=select(BenchmarkEvaluation).join(Run).where(Run.owner_id==user.id)
    rows=session.scalars(query.order_by(BenchmarkEvaluation.created_at.desc(),BenchmarkEvaluation.id).offset(offset).limit(limit))
    total=session.scalar(select(func.count()).select_from(BenchmarkEvaluation).join(Run).where(Run.owner_id==user.id))
    return {'items':[serialize(row,session)|{'run_name':session.get(Run,row.run_id).name} for row in rows],
            'total':total,'offset':offset,'limit':limit}
