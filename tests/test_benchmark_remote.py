import json
import time
from sqlalchemy import select
from fabryka_track import benchmarks
from fabryka_track.database import SessionLocal
from fabryka_track.models import BenchmarkEvaluation
from fabryka_track.settings import settings
from test_training import finished,launch

def test_runner_claim_authorization_lease_and_resume(client,monkeypatch):
    monkeypatch.setattr(settings,'benchmark_runner_tokens',json.dumps({'simp':'s'*40,'gb10':'g'*40}))
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:
        from fabryka_track.hf_publish import checkpoint_path
        from fabryka_track.models import Run
        import hashlib
        digest=hashlib.sha256(checkpoint_path(db,db.get(Run,run['id'])).read_bytes()).hexdigest()
        row=BenchmarkEvaluation(run_id=run['id'],mode='smoke',tasks=['sciq'],status='queued',provenance={'checkpoint_sha256':digest})
        db.add(row);db.commit();eid=row.id
    prefix='/api/benchmark-runner'
    assert client.post(prefix+'/claim').status_code==401
    headers={'Authorization':'Bearer '+'s'*40}
    job=client.post(prefix+'/claim',headers=headers).json()['job']
    assert job['id']==eid
    assert client.post(prefix+'/claim',headers=headers).json()['job'] is None
    assert client.get(prefix+'/'+eid+'/checkpoint',params={'lease':'wrong'},headers=headers).status_code==409
    assert client.get(prefix+'/'+eid+'/checkpoint',params={'lease':job['lease']},headers=headers).status_code==200
    url=prefix+'/'+eid+'/progress'
    assert client.post(url,json={'lease':job['lease'],'status':'finished'},headers=headers).status_code==422
    assert client.post(url,json={'lease':job['lease'],'results':{'sciq':{'accuracy':.3}}},headers=headers).status_code==200
    benchmarks.recover_evaluations()
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,eid);assert row.status=='running'
        row.provenance={**row.provenance,'heartbeat':time.time()-181};db.commit()
    benchmarks.recover_evaluations()
    newjob=client.post(prefix+'/claim',headers={'Authorization':'Bearer '+'g'*40}).json()['job']
    assert newjob['id']==eid and newjob['results']['sciq']['accuracy']==.3
    assert client.post(url,json={'lease':job['lease']},headers=headers).status_code==409
    assert client.post(url,json={'lease':newjob['lease'],'status':'finished'},headers={'Authorization':'Bearer '+'g'*40}).status_code==200


def test_retry_reuses_completed_tasks_and_does_not_repeat_finished_suite(client,monkeypatch):
    run=finished(client,launch(client).json()['id'])
    url='/api/runs/'+run['id']+'/benchmarks'
    eid=client.post(url,json={'suite':'core','mode':'smoke'}).json()['id']
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,eid);row.status='failed'
        row.results={'sciq':{'accuracy':.3},'blimp':{'error':'timeout'}}
        row.provenance={**row.provenance,'dataset_revisions':{'allenai/sciq':'pinned'}};db.commit()
    resumed=client.post(url,json={'suite':'core','mode':'smoke'}).json()
    assert resumed['id']==eid and resumed['results']=={'sciq':{'accuracy':.3}}
    assert resumed['provenance']['dataset_revisions']=={'allenai/sciq':'pinned'}
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,eid);row.status='finished';row.results={k:{'accuracy':.5} for k in benchmarks.CORE};db.commit()
    ready=client.post(url,json={'suite':'core','mode':'smoke'}).json()
    assert ready['id']==eid and ready['status']=='finished'
    extended=client.post(url,json={'suite':'tinylm','mode':'smoke'}).json()
    assert extended['status']=='queued' and len(extended['results'])==5
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,extended['id']);row.status='cancelled';db.commit()
    full=client.post(url,json={'suite':'core','mode':'full'}).json()
    assert full['results']=={} and full['mode']=='full'
