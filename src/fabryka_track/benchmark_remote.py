"""Scoped pull-worker API; no SSH credentials or user account keys on runners."""
import json
import math
import secrets
import time
from datetime import datetime, timezone
from uuid import uuid4
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from .benchmarks import evaluation_checkpoint_path, lock
from .database import session_scope
from .models import BenchmarkEvaluation
from . import wikitext_suite
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
        supported = body.protocols if body else []
        row=None
        for candidate in queued:
            if candidate.provenance.get('target_runner') not in (None,runner):continue
            protocol=candidate.provenance.get('protocol', '')
            if (protocol.startswith('tiny-ml-') or protocol==wikitext_suite.PROTOCOL) and protocol not in supported:continue
            try:
                evaluation_checkpoint_path(session,candidate)
            except HTTPException as exc:
                candidate.status='failed';candidate.error=exc.detail
                candidate.ended_at=datetime.now(timezone.utc)
                continue
            row=candidate
            break
        if not row:
            session.commit()
            return {'job':None}
        row.status='running';row.ended_at=None;row.error=None
        row.provenance={**row.provenance,'runner':runner,'lease':str(uuid4()),'heartbeat':time.time(),
                        'execution_started_at':datetime.now(timezone.utc).isoformat()}
        session.commit()
        return {'job':{'id':row.id,'tasks':row.tasks,'mode':row.mode,'results':row.results,'provenance':row.provenance,'lease':row.provenance['lease']}}


@router.get('/{eid}/checkpoint')
def checkpoint(eid:str,lease:str,runner=Depends(worker),session=Depends(session_scope)):
    row=assignment(session,eid,runner,lease)
    return FileResponse(evaluation_checkpoint_path(session,row),filename='model.pt')


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
        protected = {'checkpoint_id','artifact_id','checkpoint_storage_key','checkpoint_sha256',
                     'checkpoint_step','dataset_split','protocol','seed','fewshot','limit_per_subtask',
                     'dataset','dataset_config','evaluator_version','wikitext_task_version','detokenizer',
                     'context_policy','byte_denominator','external_comparability','target_runner','visibility','reference'}
        if 'wikitext2' in row.tasks:protected.add('dataset_revisions')
        updates={k:v for k,v in (body.provenance or {}).items() if k not in protected}
        row.provenance={**original,**updates,'runner':runner,'lease':body.lease,'heartbeat':time.time()}
        if body.results is not None:
            if set(body.results)-set(row.tasks):raise HTTPException(422,'Unexpected benchmark tasks')
            row.results=body.results
        if body.current_task is not None:row.current_task=body.current_task
        if body.status=='finished' and any(k not in row.results or row.results[k].get('error') for k in row.tasks):
            raise HTTPException(422,'All assigned tasks must finish')
        if body.status=='finished' and 'wikitext2' in row.tasks:
            result=row.results['wikitext2']
            if (result.get('protocol') != original.get('protocol') or
                    result.get('dataset_split') != original.get('dataset_split') or
                    result.get('mode') != row.mode or
                    result.get('dataset_revisions') != original.get('dataset_revisions') or
                    any(not isinstance(result.get(k),(int,float)) or isinstance(result[k],bool) or
                        not math.isfinite(result[k]) or result[k] < 0 or (k == 'byte_perplexity' and result[k] == 0)
                        for k in ('byte_perplexity','bits_per_byte')) or
                    any(type(result.get(k)) is not int or result[k] <= 0 for k in ('num_bytes','num_documents'))):
                raise HTTPException(422,'WikiText result must include complete pinned corpus metrics')
        if body.status=='finished':evaluation_checkpoint_path(session,row)
        row.status=body.status
        if body.status!='running':
            row.ended_at=datetime.now(timezone.utc);row.current_task=None;row.error=body.error
        session.commit()
        return {'status':row.status}
