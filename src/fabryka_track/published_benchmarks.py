"""Public, read-only benchmark reports with explicit metrics and provenance."""
import math
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from .benchmarks import TASKS
from .database import session_scope
from .fast_ladder import COMPONENTS as EN_COMPONENTS
from .fast_pl_ladder import COMPONENTS as PL_COMPONENTS
from .models import Account, BenchmarkEvaluation, Run
from .leaderboard_suite import DATA as CONTINUATION_TASKS

router = APIRouter(prefix='/api/benchmark-results')
NAMES = {key: value[0] for key, value in TASKS.items()} | {
    key: value['name'] for key, value in (EN_COMPONENTS | PL_COMPONENTS).items()
}
METRICS = {
    'accuracy': ('Accuracy', 'percent', True),
    'acc_norm': ('Length-normalized accuracy · acc_norm,none', 'percent', True),
    'bpb': ('Bits per UTF-8 byte', 'number', False),
    'nll': ('Negative log-likelihood', 'number', False),
    'perplexity': ('Perplexity', 'number', False),
    'elo': ('Fixed-item Overall Elo', 'elo', True),
    'index': ('Open SLM-style INT Index · all components', 'index', True),
}
EVIDENCE_FIELDS = ('protocol', 'harness_version', 'torch_version', 'fewshot', 'seed',
                   'scoring', 'scoring_implementation', 'device', 'gpu',
                   'context_limited_requests', 'total_requests', 'execution_started_at')
CHECKPOINT_FIELDS = ('checkpoint_sha256', 'checkpoint_step', 'training_tokens',
                     'token_unit', 'context_length', 'parameters')


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def scalars(data, keys):
    return {key: value for key in keys if isinstance(value := data.get(key), (str, int, float, bool))
            and (not isinstance(value, (int, float)) or math.isfinite(value))}


def mapping(value):
    return scalars(value, value.keys()) if isinstance(value, dict) else {}


def report(evaluation, run, owner):
    provenance = evaluation.provenance or {}
    measurements = []
    for task in evaluation.tasks:
        result = (evaluation.results or {}).get(task) or {}
        if result.get('error'):
            continue
        for metric, (label, unit, higher_is_better) in METRICS.items():
            value = result.get(metric)
            if not finite(value):
                continue
            if unit == 'percent' and not 0 <= value <= 1:
                continue
            metric_label = label
            if metric == 'accuracy' and task in TASKS and task != 'multiblimp_polish':
                metric_label = 'Accuracy · acc,none'
            if task in CONTINUATION_TASKS and metric in ('accuracy','acc_norm'):
                metric_label = 'Raw continuation accuracy' if metric=='accuracy' else 'Length-normalized continuation accuracy'
            measurements.append({
                'task': task, 'benchmark': NAMES.get(task, task), 'metric': metric,
                'metric_label': metric_label, 'value': value, 'unit': unit,
                'higher_is_better': higher_is_better,
                'samples': result.get('samples') if finite(result.get('samples')) else None,
                'sample_unit': result.get('unit', 'examples'),
                'sample_digest': result.get('sample_digest') if isinstance(result.get('sample_digest'), str) else None,
                'dataset_revisions': mapping(result.get('dataset_revisions') or provenance.get('dataset_revisions')),
                'task_versions': mapping(result.get('task_versions')),
                'splits': mapping(result.get('splits')),
                'elapsed_seconds': result.get('elapsed_seconds') if finite(result.get('elapsed_seconds')) else None,
            })
    return {
        'id': evaluation.id, 'run_id': run.id, 'run_name': run.name,
        'owner': owner.username if owner else 'Legacy',
        'model_size': run.config.get('model_size'),
        'mode': evaluation.mode, 'created_at': evaluation.created_at, 'ended_at': evaluation.ended_at,
        'checkpoint': scalars(provenance, CHECKPOINT_FIELDS),
        'evidence': scalars(provenance, EVIDENCE_FIELDS),
        'measurements': measurements,
        'source': 'Track evaluation',
        'source_url': '/api/benchmark-results/' + evaluation.id,
        'run_url': '/run/' + run.id,
    }


def public_query():
    return select(BenchmarkEvaluation, Run, Account).join(Run, BenchmarkEvaluation.run_id == Run.id).outerjoin(
        Account, Run.owner_id == Account.id).where(
        Run.is_public == True, Run.state == 'finished', BenchmarkEvaluation.status == 'finished')


@router.get('/campaign-status')
def campaign_status(session=Depends(session_scope)):
    rows=session.execute(select(BenchmarkEvaluation,Run).join(Run).where(
        Run.is_public==True,Run.state=='finished',BenchmarkEvaluation.mode=='full')).all()
    rows=[(evaluation,run) for evaluation,run in rows if evaluation.provenance.get('campaign')]
    if not rows:return {'total':0,'states':{},'running':[]}
    latest=max(rows,key=lambda row:row[0].created_at)[0].provenance['campaign']
    rows=[row for row in rows if row[0].provenance['campaign']==latest]
    states={state:sum(evaluation.status==state for evaluation,_ in rows) for state in ['queued','running','finished','failed','cancelled']}
    return {'total':len(rows),'states':states,'running':[{'run_name':run.name,'task':evaluation.current_task}
        for evaluation,run in rows if evaluation.status=='running']}


@router.get('')
def published(mode: Literal['full', 'smoke'] = 'full', limit: int = Query(100, ge=1, le=100),
              offset: int = Query(0, ge=0), session=Depends(session_scope)):
    query = public_query().where(BenchmarkEvaluation.mode == mode)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.execute(query.order_by(BenchmarkEvaluation.created_at.desc(), BenchmarkEvaluation.id)
                           .offset(offset).limit(limit)).all()
    return {'items': [report(*row) for row in rows], 'total': total, 'mode': mode,
            'offset': offset, 'limit': limit}


@router.get('/{evaluation_id}')
def published_detail(evaluation_id: str, session=Depends(session_scope)):
    row = session.execute(public_query().where(BenchmarkEvaluation.id == evaluation_id)).first()
    if not row:
        raise HTTPException(404, 'Published evaluation not found')
    return report(*row)
