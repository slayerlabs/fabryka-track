"""Automatic, revision-pinned evaluation of published run weights on White."""
import logging
import threading

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from .accounts import current_user, owned_run, require_user
from .database import SessionLocal, session_scope
from .models import Artifact, HFPublication, Run, WhiteBenchmark
from .settings import settings

router = APIRouter(prefix='/api/runs')
logger = logging.getLogger(__name__)
_stop = threading.Event()
_thread = None
TERMINAL = {'complete', 'partial', 'failed', 'unsupported'}


class Source(BaseModel):
    model_config = ConfigDict(extra='forbid')
    repo_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$')
    revision: str = Field(pattern=r'^[0-9a-f]{40}$')


def describe(row):
    return {'status': row.status, 'repo_id': row.repo_id, 'revision': row.revision,
            'job_id': row.job_id, 'detail': row.detail, 'result': row.result}


@router.get('/{run_id}/white-benchmark')
def status(run_id: str, session=Depends(session_scope), user=Depends(current_user)):
    run = session.get(Run, run_id)
    if not run or not (run.is_public or (user and run.owner_id == user.id)):
        raise HTTPException(404, 'Run not found')
    row = session.get(WhiteBenchmark, run.id)
    if row:
        return describe(row)
    weights = session.scalar(select(Artifact.id).where(Artifact.run_id == run.id, Artifact.name == 'model.pt').limit(1))
    return {'status': 'unsupported_checkpoint' if weights else 'waiting_for_weights', 'result': {},
            'detail': ('Track has a native checkpoint. White needs a supported Transformers model and tokenizer bundle.'
                       if weights else 'Track has no uploaded model weights. Metrics alone cannot be benchmarked.')}


@router.put('/{run_id}/white-benchmark/source')
def source(run_id: str, body: Source, session=Depends(session_scope), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    row = session.get(WhiteBenchmark, run.id)
    if row and (row.repo_id, row.revision) == (body.repo_id, body.revision):
        return describe(row)
    if row and row.status not in TERMINAL:
        raise HTTPException(409, 'Wait for the current evaluation before changing its source.')
    if row is None:
        row = WhiteBenchmark(run_id=run.id)
        session.add(row)
    row.source_kind = 'manual'
    row.repo_id, row.revision = body.repo_id, body.revision
    row.status, row.job_id, row.detail, row.result = 'pending', None, None, {}
    session.commit()
    return describe(row)


def sync_once():
    if not settings.white_benchmark_url:
        return
    # Only explicit output sources and completed public exports are candidates.
    # A base model named in training config is never substituted for trained weights.
    with SessionLocal() as session:
        for publication in session.scalars(select(HFPublication).where(
                HFPublication.status == 'finished', HFPublication.private.is_(False))):
            if not publication.commit:
                continue
            row = session.get(WhiteBenchmark, publication.run_id)
            if row is None:
                session.add(WhiteBenchmark(run_id=publication.run_id, repo_id=publication.repo_id,
                                           revision=publication.commit, status='pending', source_kind='publication'))
            elif row.source_kind == 'publication' and row.status in TERMINAL and row.revision != publication.commit:
                row.repo_id, row.revision = publication.repo_id, publication.commit
                row.status, row.job_id, row.detail, row.result = 'pending', None, None, {}
        session.commit()
        rows = list(session.scalars(select(WhiteBenchmark).where(WhiteBenchmark.status.not_in(TERMINAL))))
        with httpx.Client(base_url=settings.white_benchmark_url.rstrip('/'), timeout=25) as client:
            submitted = False
            for row in rows:
                try:
                    if not row.job_id:
                        if submitted:
                            continue
                        payload = {'model': row.repo_id, 'revision': row.revision}
                        response = client.post('/api/models/compatibility', json=payload)
                        response.raise_for_status()
                        compatible = response.json()
                        if not compatible['compatible']:
                            row.status, row.detail = 'unsupported', compatible['reason']
                            session.commit()
                            continue
                        if compatible['revision'] != row.revision:
                            raise ValueError('Revision mismatch')
                        response = client.post('/api/evaluations', json=payload)
                        response.raise_for_status()
                        job = response.json()
                        if job['revision'] != row.revision or job['model'] != row.repo_id:
                            raise ValueError('Source mismatch')
                        row.job_id = job['id']
                        row.status, row.detail = job['status'], None
                        session.commit()  # Durable assignment before polling; White deduplicates retries.
                        submitted = True
                    response = client.get('/api/evaluations/' + row.job_id)
                    response.raise_for_status()
                    job = response.json()
                    if job['revision'] != row.revision or job['model'] != row.repo_id:
                        raise ValueError('Source mismatch')
                    row.status = job['status']
                    row.result = {key: job.get(key) for key in ('metrics', 'benchmarks', 'scope', 'num_params')}
                    row.detail = 'Evaluation failed on White.' if row.status == 'failed' else None
                    session.commit()
                except (httpx.HTTPError, KeyError, ValueError):
                    row.detail = 'Waiting for the benchmark service. Track will retry automatically.'
                    session.commit()
                    logger.warning('White benchmark sync deferred for run %s', row.run_id)


def start_worker():
    global _thread
    if not settings.white_benchmark_url or (_thread and _thread.is_alive()):
        return
    _stop.clear()
    def loop():
        while not _stop.is_set():
            try:
                sync_once()
            except Exception:
                logger.exception('White benchmark sync failed')
            _stop.wait(60)
    _thread = threading.Thread(target=loop, name='white-benchmark-sync', daemon=True)
    _thread.start()


def stop_worker():
    _stop.set()
    if _thread:
        _thread.join(timeout=2)
