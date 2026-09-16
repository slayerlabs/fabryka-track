"""Admin-only CLI for a resumable, explicitly targeted leaderboard campaign.

The interactive API's queue limit remains 20; this operator command can reserve
one larger batch. It creates database jobs, never cloud instances or GPU workers.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone, timedelta
from uuid import uuid5, NAMESPACE_URL

from sqlalchemy import select
from .database import SessionLocal
from .hf_publish import checkpoint_path
from .leaderboard_suite import TASKS, PROTOCOL, REVISIONS
from .models import BenchmarkEvaluation, Run


def plan(session,name,runner,tasks=TASKS,protocol=PROTOCOL):
    output={'campaign':name,'runner':runner,'protocol':protocol,'tasks':tasks,'models':[],'excluded':[]}
    runs=list(session.scalars(select(Run).where(Run.state=='finished',Run.is_public==True)))
    runs.sort(key=lambda run:(run.config.get('parameters') or 0,str(run.started_at),run.id))
    for run in runs:
        try:
            path=checkpoint_path(session,run)
        except Exception:
            output['excluded'].append({'run_id':run.id,'name':run.name,'reason':'No supported native checkpoint'})
            continue
        digest=hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        digest=digest.hexdigest()
        eid=str(uuid5(NAMESPACE_URL,f'{name}/{protocol}/{run.id}/{digest}'))
        previous=session.get(BenchmarkEvaluation,eid)
        active=session.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id==run.id,
            BenchmarkEvaluation.status.in_(['queued','running'])))
        output['models'].append({'run_id':run.id,'name':run.name,'model_size':run.config.get('model_size'),
            'checkpoint_sha256':digest,'evaluation_id':eid,'status':previous.status if previous else 'planned',
            'conflict':bool(active and active.id!=eid)})
    return output


def enqueue(session,manifest,tasks=TASKS,protocol=PROTOCOL,revisions=REVISIONS):
    if any(row['conflict'] for row in manifest['models']):raise ValueError('Another evaluation is active; retry when it finishes')
    created=0;now=datetime.now(timezone.utc)
    for index,item in enumerate(manifest['models']):
        if session.get(BenchmarkEvaluation,item['evaluation_id']):continue
        session.add(BenchmarkEvaluation(id=item['evaluation_id'],run_id=item['run_id'],mode='full',status='queued',
            tasks=list(tasks),results={},created_at=now+timedelta(microseconds=index),
            provenance={'checkpoint_sha256':item['checkpoint_sha256'],'protocol':protocol,'fewshot':0,'seed':42,
                        'limit_per_subtask':None,'reused_tasks':[],'dataset_revisions':dict(revisions),
                        'campaign':manifest['campaign'],'target_runner':manifest['runner']}))
        created+=1
    session.commit()
    return created


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name',required=True)
    parser.add_argument('--runner',required=True)
    parser.add_argument('--enqueue',action='store_true',help='Create jobs; otherwise only print the plan')
    parser.add_argument('--suite',choices=['en','pl'],default='en',help='en: English INT-Index board; pl: separate Polish board')
    args=parser.parse_args()
    if args.suite=='pl':
        from . import pl_leaderboard_suite as pl
        tasks,protocol,revisions=pl.TASKS,pl.PROTOCOL,{}
    else:
        tasks,protocol,revisions=TASKS,PROTOCOL,REVISIONS
    with SessionLocal() as session:
        manifest=plan(session,args.name,args.runner,tasks,protocol)
        if args.enqueue:manifest['created']=enqueue(session,manifest,tasks,protocol,revisions)
        print(json.dumps(manifest,indent=2,default=str))

if __name__=='__main__':main()
