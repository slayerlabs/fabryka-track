import math

import pytest
import torch
from sqlalchemy import select

from fabryka_track import benchmarks
from fabryka_track.database import SessionLocal
from fabryka_track.models import BenchmarkEvaluation, Run
from test_training import finished, launch


def test_tiny_score_requires_all_core_and_keeps_negative():
    assert benchmarks.tiny_score({'sciq':{'normalized':.2}}) is None
    assert benchmarks.tiny_score({k:{'normalized':-.2} for k in benchmarks.CORE})==pytest.approx(-.2)
    results={k:{'normalized':.2} for k in benchmarks.CORE}
    results['lambada_openai']={'normalized':None}
    assert benchmarks.tiny_score(results)==pytest.approx(.2)


def test_evaluation_owner_visibility_and_cancellation(client,monkeypatch):
    monkeypatch.setattr(benchmarks,'supervise',lambda eid:None)
    original_find_spec=benchmarks.importlib.util.find_spec
    monkeypatch.setattr(benchmarks.importlib.util,'find_spec',lambda n:True if n=='lm_eval' else original_find_spec(n))
    run=finished(client,launch(client).json()['id'])
    url='/api/runs/'+run['id']+'/benchmarks'
    r=client.post(url,json={'suite':'extended','mode':'smoke'})
    assert r.status_code==202
    evaluation=r.json()
    assert len(evaluation['tasks'])==8
    assert client.post(url,json={}).status_code==409
    assert client.post(url,json={'suite':'untrusted-script'}).status_code==422
    assert client.post(url+'/'+evaluation['id']+'/cancel',json={}).json()['status']=='cancelled'
    client.post('/api/auth/logout')
    assert client.get(url).status_code==401
    assert client.post(url,json={}).status_code==401
    client.post('/api/auth/register',json={'username':'second','password':'different-password-123'})
    assert client.get(url).status_code==404
    assert client.post(url,json={}).status_code==404
    with SessionLocal() as db:
        db.get(Run,run['id']).is_public=True;db.commit()
    assert client.get(url).status_code==200
    assert client.post(url+'/'+evaluation['id']+'/cancel',json={}).status_code==404


def test_recovery_marks_interrupted(client):
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:
        db.add(BenchmarkEvaluation(run_id=run['id'],mode='full',tasks=benchmarks.CORE,status='running'));db.commit()
    benchmarks.recover_evaluations()
    with SessionLocal() as db:
        row=db.scalar(select(BenchmarkEvaluation));assert row.status=='failed' and row.ended_at


def test_byte_scoring_does_not_drop_long_continuations(client):
    pytest.importorskip('lm_eval')
    from fabryka_track.benchmark_model import ByteCheckpointLM
    from fabryka_track.hf_publish import checkpoint_path
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:model=ByteCheckpointLM(checkpoint_path(db,db.get(Run,run['id'])))
    class Uniform(torch.nn.Module):
        def forward(self,x):return torch.zeros((*x.shape,256))
    model.model=Uniform()
    continuation='ą'*40
    score,greedy=model.score('prefix',continuation)
    assert score==pytest.approx(-len(continuation.encode())*math.log(256))
    assert not greedy and model.truncated_requests==1
    assert model.score('','a')[0]==pytest.approx(-math.log(256))


def test_variable_choice_baseline_and_lambada():
    pytest.importorskip('lm_eval')
    from fabryka_track.benchmark_worker import summarize
    samples=[dict(resps=[0]*n,doc_id=i,doc_hash='d',prompt_hash='p',target_hash='t') for i,n in enumerate([3,4])]
    output={'samples':{'arc_easy':samples},'results':{'arc_easy':{'acc,none':.5}}}
    result=summarize('arc_easy',output)
    expected=(1/3+1/4)/2
    assert result['random_baseline']==pytest.approx(expected)
    assert result['normalized']==pytest.approx((.5-expected)/(1-expected))
    assert summarize('lambada_openai',output)['normalized'] is None
