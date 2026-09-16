"""RunPod control plane. Tokens are scoped to one run; provider keys never leave Track."""
import logging
from .provider_diagnostics import response_details

logger = logging.getLogger(__name__)

import hashlib
import io
import json
import math
import re
import secrets
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update, func

from .accounts import require_user
from .database import SessionLocal, session_scope
from .models import Artifact, Checkpoint, Dataset, GPUJob, Metric, Run, RunLog
from .settings import settings
from .dataset_storage import content_response

router = APIRouter(prefix='/api')
HALT = threading.Event()
THREAD = None
LOCK = threading.Lock()
DISPATCH_LOCK = threading.Lock()
TICK_LOCK = threading.Lock()
METRICS = {'gpu/peak_allocated_mb','gpu/peak_reserved_mb','train/learning_rate','train/loss','val/loss','val/perplexity','throughput/tokens_sec','progress','training/tokens_seen'}
FILES = {'model.pt','recipe.json','metrics.jsonl','training.log','result.json'}
CHECKPOINT_NAME = re.compile(r'^checkpoint-(\d+)\.pt$')


def allowed_artifact(name):
    """Fixed runner files, plus periodic checkpoint-<step>.pt lineage snapshots."""
    return name in FILES or bool(CHECKPOINT_NAME.match(name))
SIZES = {'8m':(256,10,8),'16m':(384,9,8),'32m':(512,10,8),'64m':(640,13,10),'128m':(768,18,12)}
PRESETS = {}
for key,(width,layers,heads) in SIZES.items():
    parameters = layers*(12*width*width+13*width)+(512+512+2)*width
    PRESETS[key]={'label':f'{key.upper()} transformer · {parameters:,} parameters', 'parameters':parameters,
                  'architecture':{'width':width,'layers':layers,'heads':heads,'context_length':512}}


def now(): return datetime.now(timezone.utc)
def utc(d): return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d

def allowed(user, session=None):
    users={s.strip().lower() for s in settings.runpod_allowed_users.split(',') if s.strip()}
    # A successful Hugging Face OAuth connection is an explicit identity signal;
    # it can use GPU credits without a second manual allowlist entry. Keep the
    # allowlist for password-only accounts and lab/service users.
    hf_connected = bool(getattr(user, 'huggingface_username', None))
    if session is not None and user and not hf_connected:
        from .models import HuggingFaceIdentity
        hf_connected = session.scalar(select(HuggingFaceIdentity.subject).where(HuggingFaceIdentity.account_id == user.id)) is not None
    return bool(settings.runpod_api_key and user and
                (hf_connected or
                 '*' in users or user.username.lower() in users))


@router.get('/training/capabilities')
def capabilities(user=Depends(require_user), session=Depends(session_scope)):
    return {'runpod_available':allowed(user, session),'models':PRESETS,'gpu':settings.runpod_gpu_type,
            'max_parallel':settings.runpod_max_parallel,
            'max_pending':settings.runpod_max_pending,
            'max_pending_per_user':settings.runpod_max_pending_per_user,
            'max_seconds':settings.runpod_max_seconds,'max_hourly_usd':settings.runpod_max_hourly_usd,
            'image':settings.runner_image,'gpu_fallbacks':[s.strip() for s in settings.runpod_gpu_fallbacks.split(',') if s.strip()]}


from .gpu_costs import cost_summary, refresh_billing


def status(session, run):
    job=session.get(GPUJob,run.id)
    if not job:return None
    ahead=session.scalar(select(func.count()).select_from(GPUJob).where(
        GPUJob.cleanup_done==False, GPUJob.run_id!=run.id,
        (GPUJob.state!='queued') | (GPUJob.created_at<job.created_at))) if job.state=='queued' else 0
    return {'phase':job.state, 'error':job.error, 'heartbeat_at':job.heartbeat_at,
            'deadline':job.deadline if job.state!='queued' else None,
            'queue_position':ahead+1 if job.state=='queued' else None,
            'allocation_attempts':job.dispatch_attempts, 'allocation_deadline':job.allocation_deadline,
            'next_retry_at':job.next_retry_at if job.state=='queued' else None,
            'cleanup_done':job.cleanup_done, 'gpu':run.metadata_.get('gpu'),
            'hourly_usd':run.metadata_.get('hourly_usd'), 'cost':cost_summary(job, run)}


def provider(method,path,**kwargs):
    # Never expose exception request headers or provider bodies to the public API.
    started = time.monotonic()
    with httpx.Client(timeout=45) as client:
        r=client.request(method,'https://rest.runpod.io/v1'+path,
                         headers={'Authorization':'Bearer '+settings.runpod_api_key},**kwargs)
        if method=='DELETE' and r.status_code==404:return None
        if r.is_error:
            payload = kwargs.get('json') or {}
            logger.warning("runpod_request_failed method=%s path=%s run=%s gpu_types=%s cloud=%s elapsed_ms=%s details=%s",
                           method, path, payload.get('name'), payload.get('gpuTypeIds'),
                           payload.get('cloudType'), round((time.monotonic()-started)*1000), response_details(r, [settings.runpod_api_key,
                           *payload.get('env', {}).values()]))
        r.raise_for_status()
        return r.json() if r.content else None


def bundle(run_id):
    folder=settings.artifact_dir/run_id;folder.mkdir(parents=True,exist_ok=True)
    path=folder/'runner.zip'
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        for name in ('native_model.py','runpod_worker.py','lr_schedule.py','corpus_files.py'):
            z.writestr(name,(Path(__file__).parent/name).read_bytes())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def enqueue(session,run):
    # Saved before dispatch: a timed-out create can be reconciled by deterministic pod name.
    job=GPUJob(run_id=run.id,token_hash='',deadline=now()+timedelta(seconds=run.config.get('max_runtime_seconds',3600)),
               bundle_sha256=bundle(run.id))
    session.add(job)


def job_auth(run_id,authorization=Header(default=''),session=Depends(session_scope)):
    job=session.get(GPUJob,run_id)
    token=authorization.removeprefix('Bearer ')
    if not job or not token or not secrets.compare_digest(job.token_hash,hashlib.sha256(token.encode()).hexdigest()):
        raise HTTPException(401,'Invalid runner credential')
    if job.cleanup_done or now()>utc(job.deadline)+timedelta(minutes=5):
        raise HTTPException(410,'Runner credential expired')
    return job


@router.get('/runner/{run_id}/bundle')
def get_bundle(run_id,job=Depends(job_auth)):
    return FileResponse(settings.artifact_dir/run_id/'runner.zip',media_type='application/zip')


@router.get('/runner/{run_id}/manifest')
def get_manifest(run_id,job=Depends(job_auth),session=Depends(session_scope)):
    run=session.get(Run,run_id)
    return {'run_id':run_id,'config':run.config,'deadline':utc(job.deadline).isoformat(),
            'image':settings.runner_image,'runner_sha256':job.bundle_sha256}


@router.get('/runner/{run_id}/datasets/{dataset_id}')
def get_data(run_id,dataset_id,job=Depends(job_auth),session=Depends(session_scope)):
    run=session.get(Run,run_id)
    if dataset_id not in {d['id'] for d in run.config['mix']}:raise HTTPException(404,'Dataset not in this run')
    d=session.get(Dataset,dataset_id)
    return content_response(d)


@router.get('/runner/{run_id}/warm-start-checkpoint')
def get_warm_start_checkpoint(run_id,job=Depends(job_auth),session=Depends(session_scope)):
    # Job-token scoped: works regardless of the parent run's owner/visibility,
    # since launch() already checked that at fork time.
    run=session.get(Run,run_id)
    warm_start=(run.config or {}).get('warm_start_checkpoint')
    if not warm_start:raise HTTPException(404,'No warm-start checkpoint for this run')
    path=settings.artifact_dir/warm_start['storage_key']
    if not path.is_file():raise HTTPException(404,'Warm-start checkpoint unavailable')
    return FileResponse(path,media_type='application/octet-stream')


class Progress(BaseModel):
    step: int = Field(ge=0)
    values: dict[str,float] = Field(default_factory=dict,max_length=10)
    message: str = Field(default='',max_length=2000)
    gpu: str | None = Field(default=None,max_length=200)


@router.post('/runner/{run_id}/progress')
def progress(run_id,body:Progress,job=Depends(job_auth),session=Depends(session_scope)):
    # Reload in the writing session: auth's session is deliberately read-only.
    job=session.get(GPUJob,run_id);run=session.get(Run,run_id)
    if job.state in ('finished','failed','cancelled'):return {'stop':True}
    if body.step>run.config['steps'] or any(k not in METRICS or not math.isfinite(v) for k,v in body.values.items()):
        raise HTTPException(422,'Invalid metric')
    job.heartbeat_at=now();job.error=None
    if run.state=='queued':run.state='running'
    if job.state in ('provisioning','starting'):job.state='running'
    if body.gpu:run.metadata_={**run.metadata_,'gpu':body.gpu}
    if body.message:session.add(RunLog(run_id=run_id,message=body.message))
    # Retried callbacks are idempotent for metric steps.
    for key,value in body.values.items():
        existing=session.scalar(select(Metric).where(Metric.run_id==run_id,Metric.key==key,Metric.step==body.step))
        if not existing:session.add(Metric(run_id=run_id,key=key,step=body.step,value=value))
    session.commit()
    return {'stop':run.state=='stopping' or now()>=utc(job.deadline)-timedelta(seconds=90)}


@router.put('/runner/{run_id}/artifacts/{name}')
async def upload(run_id,name,request:Request,x_content_sha256:str=Header(default=''),job=Depends(job_auth),session=Depends(session_scope)):
    if not allowed_artifact(name) or len(x_content_sha256)!=64:raise HTTPException(422,'Invalid artifact')
    folder=settings.artifact_dir/run_id;folder.mkdir(parents=True,exist_ok=True)
    path=folder/name;tmp=folder/(name+'.'+secrets.token_hex(6)+'.upload');size=0;digest=hashlib.sha256()
    try:
        with tmp.open('wb') as out:
            async for chunk in request.stream():
                size+=len(chunk)
                if size>(700_000_000 if name=='model.pt' else 20_000_000):raise HTTPException(413,'Artifact too large')
                digest.update(chunk);out.write(chunk)
        if digest.hexdigest()!=x_content_sha256:raise HTTPException(422,'Artifact hash mismatch')
        with LOCK:
            j=session.get(GPUJob,run_id)
            if j.state in ('finished','failed','cancelled'):raise HTTPException(409,'Run already finalized')
            tmp.replace(path)
            j.files={**j.files,name:{'sha256':digest.hexdigest(),'bytes':size}}
            a=session.scalar(select(Artifact).where(Artifact.run_id==run_id,Artifact.name==name))
            if a:a.size=size
            else:a=Artifact(run_id=run_id,name=name,size=size,storage_key=f'{run_id}/{name}');session.add(a);session.flush()
            checkpoint_name=CHECKPOINT_NAME.match(name)
            if checkpoint_name and not session.scalar(select(Checkpoint).where(Checkpoint.run_id==run_id,Checkpoint.step==int(checkpoint_name.group(1)),Checkpoint.is_best==False)):
                step=int(checkpoint_name.group(1))
                # Correlate with the most recent val/loss reported for this run at or before this step.
                val_loss=session.scalar(select(Metric.value).where(Metric.run_id==run_id,Metric.key=='val/loss',Metric.step<=step).order_by(Metric.step.desc(),Metric.id.desc()))
                session.add(Checkpoint(run_id=run_id,step=step,val_loss=val_loss,is_best=False,artifact_id=a.id))
            session.commit()
        return {'sha256':digest.hexdigest(),'bytes':size}
    finally:tmp.unlink(missing_ok=True)


class Completed(BaseModel):
    state: str = Field(pattern='^(finished|failed|cancelled)$')
    files: dict[str,str]
    result: dict
    error: str = Field(default='',max_length=2000)


@router.post('/runner/{run_id}/complete')
def complete(run_id,body:Completed,job=Depends(job_auth),session=Depends(session_scope)):
    with LOCK:
        job=session.get(GPUJob,run_id);run=session.get(Run,run_id)
        if job.state in ('finished','failed','cancelled'):return {'verified':True}
        required={'recipe.json','metrics.jsonl','training.log','result.json'}
        if body.state=='finished':required.add('model.pt')
        if not required.issubset(body.files):raise HTTPException(409,'Artifacts not yet synchronized')
        for name,digest in body.files.items():
            path=settings.artifact_dir/run_id/name
            if not allowed_artifact(name) or job.files.get(name,{}).get('sha256')!=digest or not path.is_file():
                raise HTTPException(409,'Artifact verification incomplete')
        for key in ('best_val_loss','best_val_perplexity'):
            v=body.result.get(key)
            if body.state=='finished' and (not isinstance(v,(int,float)) or not math.isfinite(v)):
                raise HTTPException(422,'Invalid result')
        job.state='cancelled' if run.state=='stopping' else body.state
        job.error=body.error or None
        run.metadata_={**run.metadata_,'training_result':body.result,'gpu_cleanup':'pending'}
        # Keep run active until provider termination has succeeded.
        session.add(RunLog(run_id=run_id,message='Artifacts verified. Terminating RunPod.' if not body.error else body.error))
        session.commit()
    return {'verified':True}


BOOTSTRAP = '''import os, urllib.request, hashlib, zipfile, io, runpy
u=os.environ['TRACK_URL']+'/api/runner/'+os.environ['TRACK_RUN_ID']+'/bundle'
r=urllib.request.Request(u,headers={'Authorization':'Bearer '+os.environ['TRACK_RUN_TOKEN'],'User-Agent':'FabrykaRunner/1'})
b=urllib.request.urlopen(r,timeout=120).read()
assert hashlib.sha256(b).hexdigest()==os.environ['TRACK_BUNDLE_SHA256']
os.makedirs('/workspace/track',exist_ok=True);os.chdir('/workspace/track')
zipfile.ZipFile(io.BytesIO(b)).extractall('.')
import sys;sys.path.insert(0,os.getcwd())
runpy.run_path('runpod_worker.py',run_name='__main__')
'''


def tick():
    # One supervisor process per deployment; never overlap ticks for a run.
    with TICK_LOCK:
        with SessionLocal() as session:
            ids=list(session.scalars(select(GPUJob.run_id).where(GPUJob.cleanup_done==False)
                                     .order_by(GPUJob.created_at, GPUJob.run_id)))
        def reconcile(run_id):
            try:
                advance(run_id)
            except Exception as exc:
                logger.warning("gpu_control_retry run=%s exception=%s", run_id, type(exc).__name__)
                with SessionLocal() as session:
                    j=session.get(GPUJob,run_id)
                    if j:
                        j.error=j.error or f'Control plane retry: {type(exc).__name__}'
                        session.commit()
        with ThreadPoolExecutor(max_workers=settings.runpod_controller_workers,
                                thread_name_prefix='gpu-control') as pool:
            list(pool.map(reconcile, ids))


def claim(run_id):
    # Reserve capacity serially; provider requests run concurrently. Cleanup
    # continues occupying a slot until deletion has been confirmed.
    with DISPATCH_LOCK, SessionLocal() as session:
        j=session.get(GPUJob,run_id);r=session.get(Run,run_id)
        if j.cleanup_done or j.state!='queued' or r.state=='stopping':return None
        if j.allocation_deadline and now()>=utc(j.allocation_deadline):
            j.state='failed';j.cleanup_done=True
            j.error='GPU allocation wait limit reached. No pod was allocated.'
            r.state='failed';r.ended_at=now()
            session.add(RunLog(run_id=run_id,message=j.error));session.commit();return None
        if j.next_retry_at and now()<utc(j.next_retry_at):return None
        active=session.scalar(select(func.count()).select_from(GPUJob).where(
            GPUJob.cleanup_done==False, GPUJob.state!='queued'))
        if active>=settings.runpod_max_parallel or active>=settings.runpod_max_concurrent:return None
        token=secrets.token_urlsafe(32)
        claimed=session.execute(update(GPUJob).where(GPUJob.run_id==run_id,GPUJob.state=='queued').values(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),state='provisioning',heartbeat_at=now(),
            allocation_deadline=j.allocation_deadline or now()+timedelta(seconds=settings.runpod_allocation_wait_seconds),
            dispatch_attempts=GPUJob.dispatch_attempts+1,missing_checks=0,next_retry_at=now()+timedelta(seconds=30),
            deadline=now()+timedelta(seconds=min(r.config.get('max_runtime_seconds',3600),settings.runpod_max_seconds))))
        session.commit()
        return token if claimed.rowcount==1 else None


def advance(run_id):
    with SessionLocal() as session:
        j=session.get(GPUJob,run_id);r=session.get(Run,run_id)
        if j.cleanup_done:return
        if j.state=='queued' and r.state=='stopping':
            j.state='cancelled';j.cleanup_done=True;r.state='cancelled';r.ended_at=now();session.commit();return
        if j.state=='queued' and r.state!='stopping':
            session.rollback()
            token=claim(run_id)
            if token is None:return
            session.refresh(j)
            session.commit()
            payload={'name':'fabryka-track-'+run_id,'imageName':settings.runner_image,
                     'computeType':'GPU','cloudType':settings.runpod_cloud_type,'gpuCount':1,
                     'gpuTypeIds':list(dict.fromkeys([settings.runpod_gpu_type]+[x.strip() for x in settings.runpod_gpu_fallbacks.split(',') if x.strip()])),'gpuTypePriority':'availability','containerDiskInGb':30,'volumeInGb':0,
                     'dockerEntrypoint':['python3','-u','-c'],'dockerStartCmd':[BOOTSTRAP],
                     'env':{'TRACK_URL':settings.public_url.rstrip('/'),'TRACK_RUN_ID':run_id,
                            'TRACK_RUN_TOKEN':token,'TRACK_BUNDLE_SHA256':j.bundle_sha256},
                     'ports':[], 'interruptible':False}
            if settings.runpod_network_volume_id:
                payload['networkVolumeId']=settings.runpod_network_volume_id
                payload['volumeMountPath']=settings.runpod_volume_mount
                payload['env']['TRACK_DATASET_DIR']=settings.runpod_volume_mount.rstrip('/')+'/datasets'
            try:pod=provider('POST','/pods',json=payload)
            except httpx.HTTPStatusError as exc:
                j.error=(f'RunPod allocation unavailable (HTTP {exc.response.status_code}); reconciling before retry.' if exc.response.status_code>=500 or exc.response.status_code==429 else f'RunPod rejected deployment (HTTP {exc.response.status_code}).')
                if exc.response.status_code<500 and exc.response.status_code!=429:j.state='failed'
                session.add(RunLog(run_id=run_id,message=j.error));session.commit();return
            # Callback may already have updated the row while provider answered.
            session.expire_all();j=session.get(GPUJob,run_id)
            j.pod_id=pod['id'];j.error=None
            logger.info('gpu_allocated run=%s pod=%s attempt=%s', run_id, j.pod_id, j.dispatch_attempts)
            session.add(RunLog(run_id=run_id,message=f'GPU pod allocated after {j.dispatch_attempts} attempt(s). Waiting for worker startup.'))
            r=session.get(Run,run_id);r.metadata_={**r.metadata_,'pod_id':j.pod_id,'hourly_usd':pod.get('adjustedCostPerHr',pod.get('costPerHr'))}
            session.commit()
            return
        if not j.pod_id:
            pods=provider('GET','/pods')
            matches=[p for p in pods if p.get('name')=='fabryka-track-'+run_id]
            if matches:
                j.pod_id=matches[0]['id'];j.error=None;session.commit()
            elif j.state=='provisioning' and (j.next_retry_at is None or now()>=utc(j.next_retry_at)):
                # Two separate provider-list confirmations precede another create.
                j.missing_checks+=1;j.next_retry_at=now()+timedelta(seconds=30)
                if j.missing_checks>=2:
                    if j.allocation_deadline is None:
                        j.allocation_deadline=now()+timedelta(seconds=settings.runpod_allocation_wait_seconds)
                    if now()<utc(j.allocation_deadline):
                        delay=min(30*2**min(max(j.dispatch_attempts-1,0),4),300)+secrets.randbelow(16)
                        j.state='queued';j.next_retry_at=now()+timedelta(seconds=delay)
                        j.error=f'GPU allocation has not succeeded; retrying in {delay}s. Allocation attempt {j.dispatch_attempts+1}. Check earlier run logs for the provider error.'
                        session.add(RunLog(run_id=run_id,message='Provider confirmed no pod exists. '+j.error))
                    else:
                        j.state='failed';j.error='GPU allocation wait limit reached. No pod was allocated.'
                session.commit()
                if j.state=='queued':return
        expired=now()>=utc(j.deadline)
        boot_failed=j.state=='provisioning' and now()-utc(j.heartbeat_at or j.created_at)>timedelta(minutes=12)
        cancel_stalled=r.state=='stopping' and now()-utc(j.heartbeat_at)>timedelta(seconds=120)
        if j.state not in ('finished','failed','cancelled') and (expired or boot_failed or cancel_stalled or (j.state=='queued' and r.state=='stopping')):
            j.state='cancelled' if r.state=='stopping' else 'failed'
            j.error='Cancelled by owner.' if r.state=='stopping' else 'GPU time limit or startup deadline exceeded.'
            session.commit()
        if j.pod_id and j.state not in ('finished','failed','cancelled'):
            try:pod=provider('GET','/pods/'+j.pod_id)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code!=404:raise
                pod=None
            if pod is None or pod.get('desiredStatus') in ('EXITED','TERMINATED'):
                j.state='failed';j.error='RunPod exited before verified artifact synchronization.';session.commit()
            elif float(pod.get('costPerHr') or 0)>settings.runpod_max_hourly_usd:
                j.state='failed';j.error='Provider hourly price exceeds configured cap.';session.commit()
            elif pod:
                r.metadata_={**r.metadata_,'hourly_usd':pod.get('adjustedCostPerHr',pod.get('costPerHr')),'pod_id':j.pod_id};session.commit()
        if j.state in ('finished','failed','cancelled'):
            if j.pod_id:
                try:provider('DELETE','/pods/'+j.pod_id)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code!=404:raise
            j.cleanup_done=True;r.state=j.state;r.ended_at=now()
            r.metadata_={**r.metadata_,'gpu_cleanup':'terminated','pod_id':j.pod_id}
            session.add(RunLog(run_id=run_id,message=(j.error+' ' if j.error else '')+'RunPod cleanup complete.'))
            session.commit()


def start_supervisor():
    global THREAD
    if not settings.runpod_api_key:return
    HALT.clear()
    def loop():
        while not HALT.is_set():
            tick();refresh_billing();HALT.wait(10)
    THREAD=threading.Thread(target=loop,daemon=True,name='runpod-supervisor');THREAD.start()


def stop_supervisor():
    HALT.set()
    if THREAD:THREAD.join(timeout=50)
