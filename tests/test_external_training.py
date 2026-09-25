import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from fabryka_track.database import SessionLocal
from fabryka_track.external_training import register_run
from fabryka_track.models import Run


def registered(client):
    rid, token = str(uuid4()), 's' * 50
    with SessionLocal() as db:
        register_run(db, run_id=rid, token=token, owner='tester', name='Existing 150M',
                     started_at=datetime.now(timezone.utc),
                     config={'planned_training_tokens': 1000, 'token_unit': 'tokenizer_tokens',
                             'tokenizer_vocab_size': 32768, 'private_path': '/private/source'})
        db.commit()
    return rid, {'Authorization': 'Bearer ' + token}


def payload(events, alive=True):
    return {'events': events, 'process_alive': alive, 'source_updated_at': '2026-09-15T12:00:00Z'}


def test_scoped_ingestion_replay_and_public_live_redaction(client):
    rid, headers = registered(client)
    url = f'/api/external-training/{rid}/progress'
    body = payload([{'line': 2, 'kind': 'checkpoint', 'step': 0, 'tokens': 0, 'sha256': 'a'*64},
                    {'line': 3, 'kind': 'update', 'step': 1, 'tokens': 200,
                     'metrics': {'loss': 3.5, 'tokens_per_second': 22000, 'learning_rate': .001, 'gradient_norm': 2.5, 'gradient_clipped': 1, 'gradient_clip_threshold': 1}},
                    {'line': 4, 'kind': 'checkpoint', 'step': 1, 'tokens': 200, 'sha256': 'b'*64}])
    assert client.post(url, json=body).status_code == 401
    for _ in range(2):
        assert client.post(url, headers=headers, json=body).status_code == 200
    assert client.post(f'/api/external-training/{uuid4()}/progress', headers=headers, json=body).status_code == 401
    client.cookies.clear()
    run = client.get(f'/api/runs/{rid}').json()
    assert run['read_only'] and run['state'] == 'running'
    assert run['config']['token_unit'] == 'tokenizer_tokens'
    assert 'external_ingest_hash' not in json.dumps(run) and '/private/source' not in json.dumps(run)
    assert run['logs'] == run['artifacts'] == []
    assert len(run['metrics']['train/loss']) == 1
    assert run['metrics']['train/loss'][0] == {'step': 1, 'value': 3.5, 'tokens': 200, 'timestamp': None}
    assert run['metrics']['optimizer/gradient_norm'][0]['value'] == 2.5
    assert run['metrics']['optimizer/gradient_clipped'][0]['value'] == 1
    assert run['metrics']['progress'][0]['value'] == 20
    assert run['metadata']['tracking']['checkpoint']['sha256'] == 'b'*64
    assert client.get('/api/external-training/live').json()[0]['id'] == rid
    with SessionLocal() as db:
        r = db.get(Run, rid); r.is_public = False; db.commit()
    assert client.get(f'/api/runs/{rid}').status_code == 401
    assert client.get('/api/external-training/live').json() == []


def test_public_running_does_not_require_legacy_opt_in(client):
    rid, _ = registered(client)
    with SessionLocal() as db:
        r = db.get(Run, rid); r.metadata_ = {**r.metadata_, 'public_live_tracking': False}; db.commit()
    client.cookies.clear()
    assert client.get(f'/api/runs/{rid}').json()['read_only'] is True
    assert client.get('/api/external-training/live').json()[0]['id'] == rid


def test_counters_completion_and_lost_process(client):
    rid, headers = registered(client)
    url = f'/api/external-training/{rid}/progress'
    update = {'line': 2, 'kind': 'update', 'step': 2, 'tokens': 500, 'metrics': {'loss': 4}}
    assert client.post(url, headers=headers, json=payload([update])).status_code == 200
    regressed = {**update, 'line': 3, 'tokens': 400}
    assert client.post(url, headers=headers, json=payload([regressed])).status_code == 409
    end = {'line': 4, 'kind': 'end', 'step': 2, 'tokens': 500, 'status': 'finished'}
    assert client.post(url, headers=headers, json=payload([end], False)).status_code == 422
    assert client.post(url, headers=headers, json=payload([], False)).json()['state'] == 'interrupted'
    update.update(line=5, step=3, tokens=1000)
    end.update(line=6, step=3, tokens=1000)
    assert client.post(url, headers=headers, json=payload([update, end], False)).json()['state'] == 'finished'
    assert client.post(url, headers=headers, json=payload([end], False)).json()['state'] == 'finished'


def test_owner_stop_reaches_scoped_sidecar_control_without_reviving_run(client):
    rid, headers = registered(client)
    assert client.get(f'/api/external-training/{rid}/control', headers=headers).json() == {'stop': False}
    assert client.post(f'/api/external-training/{rid}/stop').json() == {'state': 'stopping'}
    assert client.get(f'/api/external-training/{rid}/control', headers=headers).json() == {'stop': True}
    event = {'line': 2, 'kind': 'update', 'step': 1, 'tokens': 100, 'metrics': {'loss': 3.0}}
    assert client.post(f'/api/external-training/{rid}/progress', headers=headers, json=payload([event])).json()['state'] == 'stopping'
    paused = {'line': 3, 'kind': 'end', 'step': 1, 'tokens': 100, 'status': 'paused'}
    assert client.post(f'/api/external-training/{rid}/progress', headers=headers, json=payload([paused], False)).json()['state'] == 'paused'


def test_private_registration_is_not_publicly_discoverable(client):
    rid, token = str(uuid4()), 'p' * 50
    with SessionLocal() as db:
        register_run(db, run_id=rid, token=token, owner='tester', name='Private 149M',
                     started_at=datetime.now(timezone.utc), is_public=False,
                     config={'planned_training_tokens': 1000, 'token_unit': 'tokenizer_tokens'})
        db.commit()
    client.cookies.clear()
    assert client.get(f'/api/runs/{rid}').status_code == 401
    assert all(row['id'] != rid for row in client.get('/api/external-training/live').json())


def sidecar():
    spec = importlib.util.spec_from_file_location('sidecar', Path(__file__).parents[1]/'scripts/track_training_progress.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_sidecar_partial_write_retry_and_truncation(tmp_path, monkeypatch):
    m = sidecar(); p = tmp_path/'events.jsonl'
    p.write_text(json.dumps({'kind': 'start'})+'\n'+json.dumps({'kind': 'update', 'updates': 1, 'tokens': 100,
                  'metrics': {'loss': 3, 'private_metric': 99}})+'\n'+ '{"kind":')
    args = SimpleNamespace(events=p, pid=42)
    monkeypatch.setattr(m, 'process_identity', lambda pid: 'identity')
    state = {'process_identity': 'identity'}
    received = []
    next_state, more, count = m.sync_once(args, state, received.append)
    assert not more and count == 1 and next_state['line'] == 2
    assert received[0]['events'][0]['metrics'] == {'loss': 3}
    def fail(body): raise OSError('offline')
    with pytest.raises(OSError): m.sync_once(args, state, fail)
    assert state == {'process_identity': 'identity'}
    with p.open('a') as f: f.write('"end","status":"paused","updates":1,"tokens":100}\n')
    next_state, more, count = m.sync_once(args, next_state, received.append)
    assert count == 1 and received[-1]['events'][0]['status'] == 'paused'
    monkeypatch.setattr(m, 'process_identity', lambda pid: 'reused-pid')
    m.sync_once(args, next_state, received.append)
    assert received[-1]['process_alive'] is False
    p.write_text('')
    with pytest.raises(RuntimeError): m.sync_once(args, next_state, received.append)


def test_sidecar_writes_stop_marker_only_after_scoped_control(tmp_path, monkeypatch):
    m = sidecar(); events = tmp_path/'events.jsonl'; events.write_text('')
    marker = tmp_path/'control'/'stop'
    args = SimpleNamespace(events=events, pid=42, stop_file=marker)
    monkeypatch.setattr(m, 'process_identity', lambda pid: 'identity')
    state, _, _ = m.sync_once(args, {'process_identity': 'identity'}, lambda body: None, lambda: True)
    assert state['line'] == 0
    assert marker.read_text().startswith('Track stop requested')
