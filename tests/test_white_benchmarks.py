from uuid import uuid4

import httpx
from sqlalchemy import select

from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Artifact, HFPublication, Project, Run, WhiteBenchmark
from fabryka_track import white_benchmarks as white


def make_run():
    with SessionLocal() as db:
        project = Project(name='White test')
        db.add(project); db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, owner_id=db.scalar(select(Account.id)), name='Test')
        db.add(run); db.commit()
        return run.id


def test_missing_weights_and_owner_only_source(client):
    rid = make_run()
    assert client.get(f'/api/runs/{rid}/white-benchmark').json()['status'] == 'waiting_for_weights'
    body = {'repo_id': 'org/trained-model', 'revision': 'a' * 40}
    assert client.put(f'/api/runs/{rid}/white-benchmark/source', json={**body, 'revision': 'main'}).status_code == 422
    assert client.put(f'/api/runs/{rid}/white-benchmark/source', json=body).status_code == 200
    client.cookies.clear()
    assert client.get(f'/api/runs/{rid}/white-benchmark').status_code == 200
    assert client.put(f'/api/runs/{rid}/white-benchmark/source', json=body).status_code == 401
    with SessionLocal() as db:
        db.get(Run, rid).is_public = False; db.commit()
    assert client.get(f'/api/runs/{rid}/white-benchmark').status_code == 404


def test_sync_pins_deduplicates_and_imports_results(client, monkeypatch):
    rid = make_run()
    client.put(f'/api/runs/{rid}/white-benchmark/source', json={'repo_id': 'org/trained-model', 'revision': 'a' * 40})
    requests = []
    def handle(request):
        requests.append((request.method, request.url.path))
        if request.url.path.endswith('compatibility'):
            return httpx.Response(200, json={'compatible': True, 'revision': 'a' * 40})
        return httpx.Response(200, json={'id': 'job-1', 'model': 'org/trained-model', 'revision': 'a' * 40,
                                       'status': 'complete' if request.method == 'GET' else 'queued',
                                       'scope': 'full', 'metrics': {'blimp_acc_pct': 75}})
    real_client = httpx.Client
    monkeypatch.setattr(white.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    monkeypatch.setattr(white.settings, 'white_benchmark_url', 'http://white.test')
    white.sync_once(); white.sync_once()
    assert requests.count(('POST', '/api/evaluations')) == 1
    with SessionLocal() as db:
        row = db.get(WhiteBenchmark, rid)
        assert row.status == 'complete' and row.result['metrics']['blimp_acc_pct'] == 75


def test_unsupported_publication_never_launches_gpu_job(client, monkeypatch):
    rid = make_run()
    with SessionLocal() as db:
        run = db.get(Run, rid)
        db.add(HFPublication(run_id=rid, owner_id=run.owner_id, repo_id='org/model', commit='b' * 40,
                             status='finished', private=False)); db.commit()
    requests = []
    def handle(request):
        requests.append(request.url.path)
        return httpx.Response(200, json={'compatible': False, 'revision': 'b' * 40, 'reason': 'Unsupported model'})
    real_client = httpx.Client
    monkeypatch.setattr(white.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    monkeypatch.setattr(white.settings, 'white_benchmark_url', 'http://white.test')
    white.sync_once(); white.sync_once()
    assert requests == ['/api/models/compatibility']
    with SessionLocal() as db:
        assert db.get(WhiteBenchmark, rid).status == 'unsupported'
