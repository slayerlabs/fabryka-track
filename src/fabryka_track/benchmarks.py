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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func

from .accounts import require_user, current_user, owned_run
from .database import SessionLocal, session_scope
from .hf_publish import checkpoint_path
from .models import BenchmarkEvaluation, Run

router = APIRouter(prefix='/api')
PROTOCOL = 'tinylm-en-v1-byte-sliding'
CORE = ['sciq','arc_easy','piqa','hellaswag','blimp']
SUITES = {'core':CORE, 'tinylm':CORE+['lambada_openai'],
          'extended':CORE+['lambada_openai','winogrande','boolq']}
TASKS = {
    'sciq': ('SciQ','allenai/sciq'), 'arc_easy': ('ARC-Easy','allenai/ai2_arc'),
    'piqa': ('PIQA','baber/piqa'), 'hellaswag': ('HellaSwag','Rowan/hellaswag'),
    'blimp': ('BLiMP','nyu-mll/blimp'), 'lambada_openai': ('LAMBADA','EleutherAI/lambada_openai'),
    'winogrande': ('WinoGrande','allenai/winogrande'), 'boolq': ('BoolQ','aps/super_glue'),
}
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
    return {k:getattr(row,k) for k in ('id','run_id','status','mode','tasks','results','provenance','current_task','error','created_at','ended_at')} | {'tiny_score':tiny_score(row.results), 'protocol':PROTOCOL, 'queue_position':position}


@router.get('/benchmarks/catalog')
def catalog():
    return {'protocol':PROTOCOL, 'available':importlib.util.find_spec('lm_eval') is not None,
            'tasks':[{'id':k,'name':v[0],'url':'https://huggingface.co/datasets/'+v[1]} for k,v in TASKS.items()],
            'core':CORE,'suites':SUITES}


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
    suite: Literal['core','tinylm','extended'] = 'tinylm'
    mode: Literal['smoke','full'] = 'smoke'


@router.post('/runs/{run_id}/benchmarks',status_code=202)
def start(run_id:str,body:EvaluationInput,user=Depends(require_user),session=Depends(session_scope)):
    run=owned_run(session,run_id,user)
    path=checkpoint_path(session,run)
    if importlib.util.find_spec('lm_eval') is None:
        raise HTTPException(503,'The benchmark worker is not installed on this server.')
    with lock:
        active=session.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id==run_id, BenchmarkEvaluation.status.in_(['queued','running'])))
        if active:
            raise HTTPException(409,'This run already has a queued or running evaluation.')
        if session.scalar(select(func.count()).select_from(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='queued'))>=20:
            raise HTTPException(409,'The benchmark queue is full (20 waiting evaluations).')
        row=BenchmarkEvaluation(run_id=run.id,mode=body.mode,tasks=SUITES[body.suite],
            provenance={'checkpoint_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'protocol':PROTOCOL,
                        'fewshot':0,'seed':42,'limit_per_subtask':10 if body.mode=='smoke' else None})
        session.add(row);session.commit();session.refresh(row)
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
            row.status='failed';row.error='Evaluation worker stopped. Partial results were retained; enqueue a new evaluation to retry.'
            row.ended_at=datetime.now(timezone.utc)
        db.commit()


def queue_tick():
    recover_evaluations()
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
