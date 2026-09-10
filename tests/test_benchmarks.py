import math

import pytest
import torch
from sqlalchemy import select

from fabryka_track import benchmarks
from fabryka_track.database import SessionLocal
from fabryka_track.models import Artifact, BenchmarkEvaluation, Metric, Run
from fabryka_track.settings import settings
from fabryka_track import training
from datetime import datetime, timezone
from test_training import finished, launch


def test_tiny_score_requires_all_core_and_keeps_negative():
    assert benchmarks.tiny_score({'sciq':{'normalized':.2}}) is None
    assert benchmarks.tiny_score({k:{'normalized':-.2} for k in benchmarks.CORE})==pytest.approx(-.2)
    results={k:{'normalized':.2} for k in benchmarks.CORE}
    results['lambada_openai']={'normalized':None}
    assert benchmarks.tiny_score(results)==pytest.approx(.2)


def test_catalog_exposes_polish_ladder_without_english_score_leakage():
    assert benchmarks.SUITES['polish']==['multiblimp_polish']
    assert any(t['id']=='multiblimp' and 'Polish' in t['gate'] for t in benchmarks.TIERS)


def test_evaluation_owner_visibility_and_cancellation(client,monkeypatch):
    monkeypatch.setattr(benchmarks,'supervise',lambda eid:None)
    original_find_spec=benchmarks.importlib.util.find_spec
    monkeypatch.setattr(benchmarks.importlib.util,'find_spec',lambda n:True if n=='lm_eval' else original_find_spec(n))
    monkeypatch.setattr(benchmarks,'enqueue_auto_polish',lambda *a,**k:None)
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
    # Completed run benchmark history is public alongside the leaderboard.
    assert client.get(url).status_code==200
    assert client.post(url,json={}).status_code==401
    client.post('/api/auth/register',json={'username':'second','password':'different-password-123'})
    assert client.get(url).status_code==200
    assert client.post(url,json={}).status_code==404
    assert client.get(url).status_code==200
    assert client.post(url+'/'+evaluation['id']+'/cancel',json={}).status_code==404


def test_recovery_marks_interrupted(client):
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:
        db.add(BenchmarkEvaluation(run_id=run['id'],mode='full',tasks=benchmarks.CORE,status='running'));db.commit()
    benchmarks.recover_evaluations()
    with SessionLocal() as db:
        row=db.scalar(select(BenchmarkEvaluation));assert row.status=='failed' and row.ended_at


def test_queue_accepts_different_models_and_preserves_fifo_on_restart(client,monkeypatch):
    original=benchmarks.importlib.util.find_spec
    monkeypatch.setattr(benchmarks.importlib.util,'find_spec',lambda n:True if n=='lm_eval' else original(n))
    monkeypatch.setattr(benchmarks,'enqueue_auto_polish',lambda *a,**k:None)
    first=finished(client,launch(client).json()['id'])
    second=finished(client,launch(client).json()['id'])
    a=client.post('/api/runs/'+first['id']+'/benchmarks',json={})
    b=client.post('/api/runs/'+second['id']+'/benchmarks',json={})
    assert a.status_code==b.status_code==202
    assert a.json()['queue_position']==1 and b.json()['queue_position']==2
    benchmarks.recover_evaluations()
    q=client.get('/api/benchmarks/queue').json()
    assert q['waiting']==2 and [e['id'] for e in q['items']]==[a.json()['id'],b.json()['id']]
    started=[]
    class ImmediateThread:
        def __init__(self,target,args,**kw):self.target,self.args=target,args
        def start(self):started.append(self.args[0])
    monkeypatch.setattr(benchmarks.threading,'Thread',ImmediateThread)
    monkeypatch.setattr(benchmarks,'worker_pids',lambda:{})
    benchmarks.queue_tick();assert started==[a.json()['id']]
    with SessionLocal() as db:
        db.get(BenchmarkEvaluation,a.json()['id']).status='finished';db.commit()
    benchmarks.queue_tick();assert started==[a.json()['id'],b.json()['id']]
    client.post('/api/auth/logout')
    assert client.get('/api/benchmarks/queue').status_code==401


def test_queue_does_not_overlap_external_or_cancelled_worker(client,monkeypatch):
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:
        running=BenchmarkEvaluation(run_id=run['id'],status='running',mode='full',tasks=['sciq'])
        waiting=BenchmarkEvaluation(run_id=run['id'],status='queued',mode='full',tasks=['piqa'])
        db.add_all([running,waiting]);db.commit();eid=running.id
    monkeypatch.setattr(benchmarks,'worker_pids',lambda:{eid:12345})
    def unexpected(*a,**kw):raise AssertionError('Must not start another worker')
    monkeypatch.setattr(benchmarks.threading,'Thread',unexpected)
    benchmarks.queue_tick()
    with SessionLocal() as db:
        row=db.get(BenchmarkEvaluation,eid);assert row.status=='running'
        row.status='cancelled';db.commit()
    benchmarks.queue_tick()


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


def test_fused_prefix_scoring_matches_bytewise_reference(tmp_path):
    pytest.importorskip('lm_eval')
    from fabryka_track.benchmark_model import ByteCheckpointLM
    from fabryka_track.native_model import TinyTransformer
    torch.manual_seed(42)
    cfg=dict(width=8,layers=1,heads=2,context_length=16)
    path=tmp_path/'checkpoint.pt'
    torch.save({'config':cfg,'state_dict':TinyTransformer(**cfg).state_dict()},path)
    model=ByteCheckpointLM(path)
    for context,target in [('', 'abc'),('prefix','ąbc'),('prefix'*5,'long continuation'),('x','a'*40),('hello','')]:
        prefix=list(context.encode()) or [32];tokens=prefix+list(target.encode())
        expected=0.;greedy=True
        with torch.inference_mode():
            for i in range(len(prefix),len(tokens)):
                logits=model.model(torch.tensor([tokens[max(0,i-16):i]]))[0,-1]
                expected+=logits.log_softmax(-1)[tokens[i]].item()
                greedy=greedy and logits.argmax().item()==tokens[i]
        score,actual_greedy=model.score(context,target)
        assert score==pytest.approx(expected,abs=3e-5)
        assert actual_greedy==greedy


def test_batched_requests_match_individual_scores(tmp_path):
    pytest.importorskip('lm_eval')
    from fabryka_track.benchmark_model import ByteCheckpointLM
    from fabryka_track.native_model import TinyTransformer
    cfg=dict(width=8,layers=1,heads=2,context_length=16);path=tmp_path/'checkpoint.pt'
    torch.save({'config':cfg,'state_dict':TinyTransformer(**cfg).state_dict()},path)
    model=ByteCheckpointLM(path)
    pairs=[('A','first continuation'),('B','ą druga'),('long prefix '*4,'third')]
    individual=[model.score(*pair) for pair in pairs]
    batched=model.score_many(pairs)
    for actual,expected in zip(batched,individual):
        assert actual[0]==pytest.approx(expected[0],abs=1e-5)
        assert actual[1]==expected[1]


def test_polish_ladder_auto_queues_after_finish_and_surfaces_on_leaderboard(client, monkeypatch):
    # Drive the finished checkpoint directly; the real CPU loop is timing-flaky on some hosts.
    monkeypatch.setattr(training, 'train', lambda run_id: None)
    monkeypatch.setattr(benchmarks, 'supervise', lambda eid: None)
    original = benchmarks.importlib.util.find_spec
    monkeypatch.setattr(benchmarks.importlib.util, 'find_spec', lambda n: True if n == 'lm_eval' else original(n))
    run_id = launch(client).json()['id']
    folder = settings.artifact_dir / run_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'model.pt').write_bytes(b'stub-checkpoint')
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        run.state = 'finished'
        run.is_public = True
        run.ended_at = datetime.now(timezone.utc)
        run.metadata_ = {**run.metadata_, 'engine': 'tiny-transformer',
                         'training_result': {'best_val_loss': 1.5, 'best_val_perplexity': 4.4816890703, 'completed_steps': 10}}
        db.add(Metric(run_id=run_id, key='val/loss', step=10, value=1.5))
        db.add(Artifact(run_id=run_id, name='model.pt', storage_key=f'{run_id}/model.pt', size=15))
        db.commit()
        # The Polish ladder auto-queues on finish exactly as the training-completion hook runs it.
        assert benchmarks.enqueue_auto_polish(db, db.get(Run, run_id)) is not None
    history = client.get(f'/api/runs/{run_id}/benchmarks').json()
    polish = [e for e in history if 'multiblimp_polish' in e['tasks']]
    assert len(polish) == 1 and polish[0]['mode'] == 'smoke' and polish[0]['status'] == 'queued'
    # Once the evaluation completes, its accuracy surfaces on the leaderboard as an extra column.
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, polish[0]['id'])
        row.status = 'finished'
        row.results = {'multiblimp_polish': {'accuracy': 0.72, 'normalized': 0.44, 'samples': 100}}
        row.ended_at = datetime.now(timezone.utc)
        db.commit()
    entry = next(m for m in client.get('/api/leaderboard').json()['models'] if m['id'] == run_id)
    assert entry['polish_multiblimp'] == 0.72 and entry['polish_state'] == 'finished'
    # Idempotent: with a pinned finished result the hook reuses it instead of stacking a second eval.
    with SessionLocal() as db:
        benchmarks.enqueue_auto_polish(db, db.get(Run, run_id))
    again = client.get(f'/api/runs/{run_id}/benchmarks').json()
    assert len([e for e in again if 'multiblimp_polish' in e['tasks']]) == 1
