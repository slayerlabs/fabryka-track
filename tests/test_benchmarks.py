from conftest import sign_in
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


def test_catalog_exposes_polish_ladder_without_english_score_leakage():
    assert benchmarks.SUITES['polish']==['multiblimp_polish']
    assert any(t['id']=='multiblimp' and 'Polish' in t['gate'] for t in benchmarks.TIERS)


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
    # Completed run benchmark history is public alongside the leaderboard.
    assert client.get(url).status_code==200
    assert client.post(url,json={}).status_code==401
    sign_in(client, 'second')
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


def test_piqa_only_queues_one_task(client, monkeypatch):
    monkeypatch.setattr(benchmarks, 'supervise', lambda eid: None)
    original = benchmarks.importlib.util.find_spec
    monkeypatch.setattr(benchmarks.importlib.util, 'find_spec', lambda n: True if n == 'lm_eval' else original(n))
    run = finished(client, launch(client).json()['id'])
    response = client.post('/api/runs/' + run['id'] + '/benchmarks', json={'suite': 'piqa', 'mode': 'full'})
    assert response.status_code == 202
    assert response.json()['tasks'] == ['piqa']
    assert benchmarks.tiny_score({'piqa': {'normalized': .1}}) is None


@pytest.mark.parametrize('ended_status', ['failed', 'cancelled'])
def test_automatic_benchmark_only_after_completion_and_once(client, monkeypatch, ended_status):
    monkeypatch.setattr(benchmarks, 'supervise', lambda eid: None)
    run = finished(client, launch(client).json()['id'])
    with SessionLocal() as db:
        db.get(Run, run['id']).state = 'running'; db.commit()
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        assert db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])) is None
        db.get(Run, run['id']).state = 'finished'; db.commit()
    benchmarks.enqueue_automatic()
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        rows = list(db.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])))
        assert len(rows) == 1
        assert rows[0].tasks == ['wikitext', 'blimp', 'arc_easy', 'aci']
        assert rows[0].mode == 'full' and rows[0].provenance['protocol'] == benchmarks.TINY_ML_PROTOCOL
        assert rows[0].provenance['visibility'] == 'private'
        assert db.get(Run, run['id']).metadata_['auto_benchmark_id'] == rows[0].id
        rows[0].status = ended_status; db.commit()
        current = db.get(Run, run['id'])
        current.metadata_ = {k: v for k, v in current.metadata_.items() if k != 'auto_benchmark_id'}
        db.commit()
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        assert db.get(Run, run['id']).state == 'finished'
        assert len(list(db.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])))) == 1


@pytest.mark.parametrize('state, enabled', [('cancelled', True), ('finished', False)])
def test_automatic_benchmark_respects_cancelled_training_and_opt_out(client, state, enabled):
    run = finished(client, launch(client, auto_benchmark=enabled).json()['id'])
    with SessionLocal() as db:
        db.get(Run, run['id']).state = state; db.commit()
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        assert db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])) is None


def test_automatic_benchmark_replaces_incompatible_piqa_marker_after_deferral(client):
    run = finished(client, launch(client, auto_benchmark_suite='piqa').json()['id'])
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        previous = db.scalar(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id']))
        assert previous.tasks == ['piqa']
        previous_id = previous.id
        current = db.get(Run, run['id'])
        current.config = {**current.config, 'auto_benchmark_suite': 'tiny_ml'}
        db.commit()
        assert benchmarks.auto_benchmark_summary(db, current) is None
    # The old running/queued job still occupies this model's slot.
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        assert len(list(db.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])))) == 1
        db.get(BenchmarkEvaluation, previous_id).status = 'finished'; db.commit()
    benchmarks.enqueue_automatic()
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        rows = list(db.scalars(select(BenchmarkEvaluation).where(BenchmarkEvaluation.run_id == run['id'])))
        assert len(rows) == 2
        linked = db.get(BenchmarkEvaluation, db.get(Run, run['id']).metadata_['auto_benchmark_id'])
        assert linked.id != previous_id and linked.tasks == ['wikitext', 'blimp', 'arc_easy', 'aci']
        assert linked.provenance['protocol'] == benchmarks.TINY_ML_PROTOCOL


def test_automatic_benchmark_does_not_link_previous_protocol(client):
    run = finished(client, launch(client).json()['id'])
    with SessionLocal() as db:
        previous = BenchmarkEvaluation(run_id=run['id'], mode='full', tasks=benchmarks.TINY_ML_TASKS,
                                       status='finished', provenance={'protocol': 'tiny-ml-en-v1-byte-sliding'})
        db.add(previous); db.flush()
        current = db.get(Run, run['id'])
        current.metadata_ = {**current.metadata_, 'auto_benchmark_id': previous.id}
        db.commit(); previous_id = previous.id
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        linked = db.get(BenchmarkEvaluation, db.get(Run, run['id']).metadata_['auto_benchmark_id'])
        assert linked.id != previous_id and linked.provenance['protocol'] == benchmarks.TINY_ML_PROTOCOL
        assert db.get(BenchmarkEvaluation, previous_id).status == 'finished'


def test_private_automatic_metrics_are_owner_only_on_public_run(client):
    run = finished(client, launch(client).json()['id'])
    rid = run['id']
    client.patch(f'/api/training/{rid}/visibility', json={'is_public': True})
    benchmarks.enqueue_automatic()
    url = f'/api/runs/{rid}/benchmarks'
    queued = client.get('/api/benchmarks/queue').json()['items']
    assert queued[0]['tasks'] == ['wikitext', 'blimp', 'arc_easy', 'aci']
    with SessionLocal() as db:
        evaluation = db.get(BenchmarkEvaluation, db.get(Run, rid).metadata_['auto_benchmark_id'])
        evaluation.results = {'aci': {'aci_score': 62.5}}
        evaluation.current_task = 'aci'
        db.commit()
    assert client.get(url).json()[0]['results']['aci']['aci_score'] == 62.5
    client.post('/api/auth/logout')
    assert client.get(url).json() == []
    models = [m for size in client.get('/api/leaderboard').json()['sizes'] for m in size['models']]
    assert next(m for m in models if m['id'] == rid)['auto_benchmark'] is None
    sign_in(client, 'second')
    assert client.get(url).json() == []
    assert client.get('/api/benchmarks/queue').json()['items'] == []
    assert client.get('/api/benchmarks/evaluations').json()['items'] == []


def test_automatic_benchmark_does_not_link_other_checkpoint(client):
    run = finished(client, launch(client).json()['id'])
    with SessionLocal() as db:
        previous = BenchmarkEvaluation(run_id=run['id'], mode='full', tasks=benchmarks.TINY_ML_TASKS,
                                       status='finished', provenance={'protocol': benchmarks.TINY_ML_PROTOCOL,
                                                                      'checkpoint_sha256': 'other-checkpoint'})
        db.add(previous); db.commit(); previous_id = previous.id
    benchmarks.enqueue_automatic()
    with SessionLocal() as db:
        linked = db.get(BenchmarkEvaluation, db.get(Run, run['id']).metadata_['auto_benchmark_id'])
        assert linked.id != previous_id
        assert linked.provenance['checkpoint_sha256'] != 'other-checkpoint'


def test_tiny_ml_remote_claim_requires_matching_protocol(client, monkeypatch):
    from fabryka_track import benchmark_remote
    monkeypatch.setattr(benchmark_remote, 'runners', lambda: {'worker': 'x' * 40})
    run = finished(client, launch(client).json()['id'])
    benchmarks.enqueue_automatic()
    headers = {'Authorization': 'Bearer ' + 'x' * 40}
    url = '/api/benchmark-runner/claim'
    old_protocol = 'tiny-ml-en-v1-byte-sliding'
    assert client.post(url, headers=headers, json={'protocols': [old_protocol]}).json()['job'] is None
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, db.get(Run, run['id']).metadata_['auto_benchmark_id'])
        eid = row.id
        row.provenance = {**row.provenance, 'protocol': old_protocol}; db.commit()
    assert client.post(url, headers=headers, json={'protocols': [benchmarks.TINY_ML_PROTOCOL]}).json()['job'] is None
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, eid)
        row.provenance = {**row.provenance, 'protocol': benchmarks.TINY_ML_PROTOCOL}; db.commit()
    job = client.post(url, headers=headers, json={'protocols': [benchmarks.TINY_ML_PROTOCOL]}).json()['job']
    assert job['id'] == eid and job['tasks'] == ['wikitext', 'blimp', 'arc_easy', 'aci']


def test_leaderboard_surfaces_automatic_benchmark(client):
    run = finished(client, launch(client).json()['id'])
    assert run['state'] == 'finished'
    rid = run['id']
    client.patch(f'/api/training/{rid}/visibility', json={'is_public': True})
    with SessionLocal() as db:
        ev = BenchmarkEvaluation(run_id=rid, mode='full', tasks=benchmarks.SUITES['polish'], status='finished',
                                 results={'multiblimp_polish': {'accuracy': 0.72, 'normalized': 0.44, 'samples': 200}},
                                 provenance={'protocol': benchmarks.PROTOCOL})
        db.add(ev); db.flush()
        r = db.get(Run, rid)
        r.config = {**r.config, 'auto_benchmark_suite': 'polish'}
        r.metadata_ = {**r.metadata_, 'auto_benchmark_id': ev.id}
        db.commit()
    models = [m for size in client.get('/api/leaderboard').json()['sizes'] for m in size['models']]
    ab = next(m for m in models if m['id'] == rid)['auto_benchmark']
    assert ab and ab['label'] == 'Polish MultiBLiMP' and ab['score'] == 0.72
    assert ab['state'] == 'finished' and ab['is_percent'] is True and ab['suite'] == 'polish'
    # A run without an automatic benchmark surfaces nothing.
    other = finished(client, launch(client, name='No automatic benchmark run').json()['id'])
    client.patch(f"/api/training/{other['id']}/visibility", json={'is_public': True})
    later = [m for size in client.get('/api/leaderboard').json()['sizes'] for m in size['models']]
    assert next(m for m in later if m['id'] == other['id'])['auto_benchmark'] is None


def test_leaderboard_surfaces_fast_pl_ladder(client):
    run = finished(client, launch(client).json()['id'])
    rid = run['id']
    client.patch(f'/api/training/{rid}/visibility', json={'is_public': True})
    with SessionLocal() as db:
        ev = BenchmarkEvaluation(run_id=rid, mode='full', status='finished',
                                 tasks=['pl_lm', 'pl_multiblimp', 'pl_induction'],
                                 results={'pl_lm': {'normalized': 0.5}, 'pl_multiblimp': {'normalized': 0.1}, 'pl_induction': {'normalized': 0.2}},
                                 provenance={'protocol': 'fast-pl-v1'})
        db.add(ev); db.flush()
        r = db.get(Run, rid)
        r.config = {**r.config, 'auto_benchmark_suite': 'fast_pl'}
        r.metadata_ = {**r.metadata_, 'auto_benchmark_id': ev.id}
        db.commit()
    ab = next(m for size in client.get('/api/leaderboard').json()['sizes'] for m in size['models'] if m['id'] == rid)['auto_benchmark']
    assert ab['label'] == 'Polish ladder' and ab['is_percent'] is False and ab['suite'] == 'fast_pl'
    assert ab['score'] == pytest.approx(0.5 * .60 + 0.1 * .30 + 0.2 * .10)  # pl_score weighting
