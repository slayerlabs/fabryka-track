"""Scoped pull-worker API; no SSH credentials or user account keys on runners."""
import json
import secrets
import time
from datetime import datetime, timezone
from uuid import uuid4
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from .benchmarks import lock
from .database import session_scope
from .hf_publish import checkpoint_path
from .models import BenchmarkEvaluation, Run
from .settings import settings

router=APIRouter(prefix='/api/benchmark-runner')

def runners():
    return json.loads(settings.benchmark_runner_tokens)

def worker(authorization: str=Header(default='')):
    token=authorization.removeprefix('Bearer ')
    for name,key in runners().items():
        if len(key)>=32 and secrets.compare_digest(token,key):return name
    raise HTTPException(401,'Invalid runner credential')


def assignment(session,eid,runner,lease):
    row=session.get(BenchmarkEvaluation,eid)
    if not row or row.status!='running' or row.provenance.get('runner')!=runner or row.provenance.get('lease')!=lease:
        raise HTTPException(409,'Assignment is no longer active')
    return row


class ClaimCapabilities(BaseModel):
    protocols: list[str] = Field(default_factory=list, max_length=20)


@router.post('/claim')
def claim(body: ClaimCapabilities | None = None, runner=Depends(worker),session=Depends(session_scope)):
    with lock:
        active=list(session.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='running')))
        if any(r.provenance.get('runner')==runner for r in active):return {'job':None}
        queued=session.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.status=='queued').order_by(BenchmarkEvaluation.created_at,BenchmarkEvaluation.id))
        from .tiny_ml_suite import PROTOCOL as tiny_protocol
        supported = body.protocols if body else []
        row=next((row for row in queued if row.provenance.get('target_runner') in (None,runner)
                  and (row.provenance.get('protocol') != tiny_protocol or tiny_protocol in supported)),None)
        if not row:return {'job':None}
        checkpoint_path(session,session.get(Run,row.run_id))
        row.status='running';row.ended_at=None;row.error=None
        row.provenance={**row.provenance,'runner':runner,'lease':str(uuid4()),'heartbeat':time.time(),
                        'execution_started_at':datetime.now(timezone.utc).isoformat()}
        session.commit()
        return {'job':{'id':row.id,'tasks':row.tasks,'mode':row.mode,'results':row.results,'provenance':row.provenance,'lease':row.provenance['lease']}}


@router.get('/{eid}/checkpoint')
def checkpoint(eid:str,lease:str,runner=Depends(worker),session=Depends(session_scope)):
    row=assignment(session,eid,runner,lease)
    return FileResponse(checkpoint_path(session,session.get(Run,row.run_id)),filename='model.pt')


class Progress(BaseModel):
    lease: str
    status: str='running'
    current_task: str|None=None
    results: dict|None=None
    provenance: dict|None=None
    error: str|None=Field(default=None,max_length=1000)


@router.post('/{eid}/progress')
def progress(eid:str,body:Progress,runner=Depends(worker),session=Depends(session_scope)):
    if body.status not in ('running','finished','failed'):raise HTTPException(422,'Invalid status')
    with lock:
        row=assignment(session,eid,runner,body.lease)
        original=row.provenance
        row.provenance={**original,**(body.provenance or {}),'runner':runner,'lease':body.lease,'heartbeat':time.time(),
                        'checkpoint_sha256':original['checkpoint_sha256'],
                        **{key:original[key] for key in ('visibility','protocol','reference') if key in original}}
        if body.results is not None:
            if set(body.results)-set(row.tasks):raise HTTPException(422,'Unexpected benchmark tasks')
            row.results=body.results
        if body.current_task is not None:row.current_task=body.current_task
        if body.status=='finished' and any(k not in row.results or row.results[k].get('error') for k in row.tasks):
            raise HTTPException(422,'All assigned tasks must finish')
        row.status=body.status
        if body.status!='running':
            row.ended_at=datetime.now(timezone.utc);row.current_task=None;row.error=body.error
        session.commit()
        return {'status':row.status}
