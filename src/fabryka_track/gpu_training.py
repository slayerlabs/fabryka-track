"""RunPod control plane. Tokens are scoped to one run; provider keys never leave Track."""
import hashlib
import io
import json
import math
import secrets
import threading
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from .accounts import require_user
from .database import SessionLocal, session_scope
from .models import Artifact, Dataset, GPUJob, Metric, Run, RunLog
from .settings import settings

router = APIRouter(prefix='/api')
HALT = threading.Event()
THREAD = None
LOCK = threading.Lock()
METRICS = {'train/loss','val/loss','val/perplexity','throughput/tokens_sec','progress','training/tokens_seen'}
FILES = {'model.pt','recipe.json','metrics.jsonl','training.log','result.json'}
SIZES = {'8m':(256,10,8),'16m':(384,9,8),'32m':(512,10,8),'64m':(640,13,10),'128m':(768,18,12)}
PRESETS = {}
for key,(width,layers,heads) in SIZES.items():
    parameters = layers*(12*width*width+13*width)+(512+512+2)*width
    PRESETS[key]={'label':f'{key.upper()} transformer · {parameters:,} parameters', 'parameters':parameters,
                  'architecture':{'width':width,'layers':layers,'heads':heads,'context_length':512}}


def now(): return datetime.now(timezone.utc)
def utc(d): return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d

def allowed(user):
    users={s.strip().lower() for s in settings.runpod_allowed_users.split(',') if s.strip()}
    return bool(settings.runpod_api_key and user and user.username.lower() in users)


@router.get('/training/capabilities')
def capabilities(user=Depends(require_user)):
    return {'runpod_available':allowed(user),'models':PRESETS,'gpu':settings.runpod_gpu_type,
            'max_seconds':settings.runpod_max_seconds,'max_hourly_usd':settings.runpod_max_hourly_usd,
            'image':settings.runner_image}


def provider(method,path,**kwargs):
    # Never expose exception request headers or provider bodies to the public API.
    with httpx.Client(timeout=45) as client:
        r=client.request(method,'https://rest.runpod.io/v1'+path,
                         headers={'Authorization':'Bearer '+settings.runpod_api_key},**kwargs)
        if method=='DELETE' and r.status_code==404:return None
        r.raise_for_status()
        return r.json() if r.content else None


def bundle(run_id):
    folder=settings.artifact_dir/run_id;folder.mkdir(parents=True,exist_ok=True)
    path=folder/'runner.zip'
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        for name in ('native_model.py','runpod_worker.py'):
            z.writestr(name,(Path(__file__).parent/name).read_bytes())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def enqueue(session,run):
    # Saved before dispatch: a timed-out create can be reconciled by deterministic pod name.
    job=GPUJob(run_id=run.id,token_hash='',deadline=now()+timedelta(seconds=settings.runpod_max_seconds),
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
    return PlainTextResponse(d.content,headers={'X-Dataset-SHA256':d.sha256})


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
    if name not in FILES or len(x_content_sha256)!=64:raise HTTPException(422,'Invalid artifact')
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
            else:session.add(Artifact(run_id=run_id,name=name,size=size,storage_key=f'{run_id}/{name}'))
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
            if name not in FILES or job.files.get(name,{}).get('sha256')!=digest or not path.is_file():
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
    with SessionLocal() as session:
        jobs=list(session.scalars(select(GPUJob).where(GPUJob.cleanup_done==False)))
    for snapshot in jobs:
        try:
            advance(snapshot.run_id)
        except Exception as exc:
            with SessionLocal() as session:
                j=session.get(GPUJob,snapshot.run_id)
                if j:j.error=j.error or f'Control plane retry: {type(exc).__name__}';session.commit()


def advance(run_id):
    with SessionLocal() as session:
        j=session.get(GPUJob,run_id);r=session.get(Run,run_id)
        if j.cleanup_done:return
        if j.state=='queued' and r.state!='stopping':
            token=secrets.token_urlsafe(32)
            claimed=session.execute(update(GPUJob).where(GPUJob.run_id==run_id,GPUJob.state=='queued').values(
                token_hash=hashlib.sha256(token.encode()).hexdigest(),state='provisioning',heartbeat_at=now()))
            session.commit()
            if claimed.rowcount!=1:return
            session.refresh(j)
            payload={'name':'fabryka-track-'+run_id,'imageName':settings.runner_image,
                     'computeType':'GPU','cloudType':settings.runpod_cloud_type,'gpuCount':1,
                     'gpuTypeIds':[settings.runpod_gpu_type],'containerDiskInGb':30,'volumeInGb':0,
                     'dockerEntrypoint':['python3','-u','-c'],'dockerStartCmd':[BOOTSTRAP],
                     'env':{'TRACK_URL':settings.public_url.rstrip('/'),'TRACK_RUN_ID':run_id,
                            'TRACK_RUN_TOKEN':token,'TRACK_BUNDLE_SHA256':j.bundle_sha256},
                     'ports':[], 'interruptible':False}
            try:pod=provider('POST','/pods',json=payload)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code<500:
                    j.state='failed';j.error=f'RunPod rejected deployment (HTTP {exc.response.status_code}).';session.commit()
                raise
            # Callback may already have updated the row while provider answered.
            session.expire_all();j=session.get(GPUJob,run_id)
            j.pod_id=pod['id'];j.error=None
            r=session.get(Run,run_id);r.metadata_={**r.metadata_,'pod_id':j.pod_id}
            session.commit()
            return
        if not j.pod_id:
            pods=provider('GET','/pods')
            matches=[p for p in pods if p.get('name')=='fabryka-track-'+run_id]
            if matches:j.pod_id=matches[0]['id'];session.commit()
        expired=now()>=utc(j.deadline)
        boot_failed=j.state=='provisioning' and now()-utc(j.created_at)>timedelta(minutes=12)
        cancel_stalled=r.state=='stopping' and now()-utc(j.heartbeat_at)>timedelta(seconds=120)
        if expired or boot_failed or cancel_stalled or (j.state=='queued' and r.state=='stopping'):
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
        if j.state in ('finished','failed','cancelled'):
            if j.pod_id:provider('DELETE','/pods/'+j.pod_id)
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
            tick();HALT.wait(10)
    THREAD=threading.Thread(target=loop,daemon=True,name='runpod-supervisor');THREAD.start()


def stop_supervisor():
    HALT.set()
    if THREAD:THREAD.join(timeout=50)
