"""Run-scoped, replay-safe ingestion for training started outside Track."""
import argparse
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid5

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, FiniteFloat
from sqlalchemy import select

from .accounts import digest
from .database import SessionLocal, session_scope
from .models import Account, IngestedEvent, Project, Run
from .namespaces import append_series

router = APIRouter(prefix='/api/external-training')
METRICS = {'loss': 'train/loss', 'tokens_per_second': 'throughput/tokens_sec',
           'gradient_norm': 'optimizer/gradient_norm', 'learning_rate': 'optimizer/learning_rate'}
PUBLIC_METRICS = {*METRICS.values(), 'training/tokens_seen', 'progress',
                  'checkpoint/tokens', 'checkpoint/step', 'validation/bpb'}


class TrainingEvent(BaseModel):
    line: int = Field(ge=1)
    kind: Literal['update', 'checkpoint', 'evaluation', 'end', 'failed']
    step: int = Field(default=0, ge=0)
    tokens: int = Field(default=0, ge=0)
    metrics: dict[str, FiniteFloat] = Field(default_factory=dict, max_length=20)
    sha256: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    status: Literal['finished', 'paused', 'failed'] | None = None


class ProgressBatch(BaseModel):
    events: list[TrainingEvent] = Field(default_factory=list, max_length=200)
    source_updated_at: datetime
    process_alive: bool


def is_shared_live(run):
    return bool(run.is_public and run.metadata_.get('public_live_tracking') is True
                and run.metadata_.get('engine') in {'external-training', 'sdk'})


@router.get('/live')
def live_runs(session=Depends(session_scope)):
    runs = session.scalars(select(Run).where(Run.is_public.is_(True), Run.state.in_(['running', 'paused', 'interrupted']))
                           .order_by(Run.started_at.desc()))
    return [{'id': r.id, 'name': r.name, 'state': r.state,
             'target_tokens': r.config.get('planned_training_tokens'),
             'tracking': r.metadata_.get('tracking', {})}
            for r in runs if is_shared_live(r) and r.metadata_.get('engine') == 'external-training'][:50]


@router.post('/{run_id}/progress')
def progress(run_id: str, body: ProgressBatch, request: Request, session=Depends(session_scope)):
    run = session.get(Run, run_id)
    token = request.headers.get('authorization', '').removeprefix('Bearer ')
    stored = run.metadata_.get('external_ingest_hash', '') if run else ''
    if not run or run.metadata_.get('engine') != 'external-training' or not stored or not hmac.compare_digest(stored, digest(token)):
        raise HTTPException(401, 'Invalid training-run credential.')
    now = datetime.now(timezone.utc)
    tracking = dict(run.metadata_.get('tracking', {}))
    target = run.config['planned_training_tokens']
    for event in body.events:
        eid = str(uuid5(UUID(run_id), f'event-line:{event.line}'))
        if session.get(IngestedEvent, eid):
            continue
        if event.line <= tracking.get('last_line', 0):
            raise HTTPException(409, 'Events must be sent in source order.')
        values = {}
        if event.kind == 'update':
            if event.tokens < tracking.get('tokens_seen', 0) or event.step <= tracking.get('step', -1):
                raise HTTPException(409, 'Training counters must increase.')
            values = {v: event.metrics[k] for k, v in METRICS.items() if k in event.metrics}
            values.update({'training/tokens_seen': event.tokens, 'progress': min(100, 100 * event.tokens / target)})
            tracking.update(step=event.step, tokens_seen=event.tokens)
            run.state = 'running'
            run.ended_at = None
        elif event.kind == 'checkpoint':
            values = {'checkpoint/tokens': event.tokens, 'checkpoint/step': event.step}
            tracking['checkpoint'] = {'step': event.step, 'tokens': event.tokens, 'sha256': event.sha256}
        elif event.kind == 'evaluation':
            if 'bpb' in event.metrics:
                values['validation/bpb'] = event.metrics['bpb']
        elif event.kind in ('end', 'failed'):
            state = 'failed' if event.kind == 'failed' else event.status
            if state not in ('finished', 'paused', 'failed') or (state == 'finished' and event.tokens < target):
                raise HTTPException(422, 'Completion requires the configured token target.')
            run.state, run.ended_at = state, now
        if values:
            append_series(session, run, {k: [[event.step, v]] for k, v in values.items()}, now)
        session.add(IngestedEvent(id=eid))
        session.flush()
        tracking['last_line'] = event.line
    if not body.process_alive and run.state == 'running':
        run.state, run.ended_at = 'interrupted', now
    tracking.update(received_at=now.isoformat(), source_updated_at=body.source_updated_at.isoformat(),
                    process_alive=body.process_alive)
    run.metadata_ = {**run.metadata_, 'tracking': tracking}
    session.commit()
    return {'accepted_line': tracking.get('last_line', 0), 'state': run.state}


def register_run(session, *, run_id, owner, name, config, started_at, token):
    """Operator registration; no training process or account credential changes."""
    if session.get(Run, run_id):
        raise ValueError('Run already exists; reuse its existing sidecar credentials.')
    account = session.scalar(select(Account).where(Account.username == owner))
    if not account:
        raise ValueError('Unknown owner account')
    if config.get('planned_training_tokens', 0) <= 0:
        raise ValueError('A positive planned_training_tokens value is required')
    project = session.scalar(select(Project).where(Project.name == 'rfc005'))
    if not project:
        project = Project(name='rfc005'); session.add(project); session.flush()
    run = Run(id=run_id, owner_id=account.id, project_id=project.id, name=name, config=config,
              state='running', is_public=True, started_at=started_at,
              metadata_={'engine': 'external-training', 'public_live_tracking': True,
                         'external_ingest_hash': digest(token), 'tracking': {}},
              note='Live metrics from the existing training process. Checkpoints remain on the training host.')
    session.add(run)
    return run


def main():
    p = argparse.ArgumentParser(description='Register an existing training run for live metric ingestion.')
    p.add_argument('--run-id', required=True, type=UUID)
    p.add_argument('--owner', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--config', required=True)
    p.add_argument('--started-at', required=True)
    p.add_argument('--credential-file', required=True)
    args = p.parse_args()
    token = secrets.token_urlsafe(40)
    # O_EXCL prevents accidental replacement of a working sidecar credential.
    fd = os.open(args.credential_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with SessionLocal() as session:
            register_run(session, run_id=str(args.run_id), owner=args.owner, name=args.name,
                         config=json.loads(Path(args.config).read_text()),
                         started_at=datetime.fromisoformat(args.started_at), token=token)
            with os.fdopen(fd, 'w') as f:
                f.write(f'TRACK_TRAINING_TOKEN={token}\n')
            session.commit()
    except BaseException:
        Path(args.credential_file).unlink(missing_ok=True)
        raise
    print(json.dumps({'run_id': str(args.run_id), 'url': f'https://track.fabryka.ai/run/{args.run_id}'}))


if __name__ == '__main__':
    main()
