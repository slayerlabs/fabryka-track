import json
import threading
from datetime import datetime, timezone

import httpx
from fabryka.client import RunClient


def response(status=200):
    return httpx.Response(status, request=httpx.Request('POST', 'https://example.test/api/events'))


def test_flush_waits_for_inflight_request(monkeypatch, tmp_path):
    entered, release = threading.Event(), threading.Event()
    def post(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return response()
    monkeypatch.setattr(httpx, 'post', post)
    run = RunClient(spool_dir=tmp_path).init('test', 'inflight')
    assert entered.wait(2)
    assert run._queue.empty()  # The old finish check incorrectly treated this as delivered.
    assert run.flush(.03) is False
    release.set()
    assert run.close(2) is True
    assert not list(tmp_path.glob('*.jsonl'))


def test_failed_artifact_keeps_copy_and_namespace(monkeypatch, tmp_path):
    seen = threading.Event()
    calls = []
    def post(url, **kwargs):
        if url.endswith('/artifacts'):
            calls.append(kwargs['data'])
            seen.set()
            return response(503)
        return response()
    monkeypatch.setattr(httpx, 'post', post)
    source = tmp_path / 'receipt.json'
    source.write_text('{"sha256":"test"}')
    run = RunClient(spool_dir=tmp_path / 'spool').init('test', 'artifact')
    run.artifact(source, namespace='checkpoints/receipt')
    assert seen.wait(2)
    run.close(.03)
    assert calls[0] == {'namespace': 'checkpoints/receipt'}
    assert list((tmp_path / 'spool/artifacts').rglob('*.json'))
    assert any(json.loads(p.read_text())['type'] == 'run.artifact'
               for p in (tmp_path / 'spool').glob('*.jsonl'))


def test_restart_recovers_same_run_pending_events_only(monkeypatch, tmp_path):
    run_id = 'same-run'
    event = {'id': 'recover-me', 'type': 'run.metrics',
             'timestamp': datetime.now(timezone.utc).isoformat(),
             'payload': {'run_id': run_id, 'step': 9, 'metrics': {'train/loss': 2}}}
    (tmp_path / '1-pending.jsonl').write_text(json.dumps(event))
    other = {**event, 'id': 'another-account', 'payload': {**event['payload'], 'run_id': 'other-run'}}
    (tmp_path / '2-other.jsonl').write_text(json.dumps(other))
    seen = []
    def post(*args, **kwargs):
        seen.extend(kwargs['json']['events'])
        return response()
    monkeypatch.setattr(httpx, 'post', post)
    run = RunClient(spool_dir=tmp_path).init('test', 'resume', run_id=run_id)
    assert run.close(2)
    assert sum(e['id'] == 'recover-me' for e in seen) == 1
    assert (tmp_path / '2-other.jsonl').exists()
    assert not any(e['type'] == 'run.finish' for e in seen)


def test_source_timestamp_and_event_id_preserved(monkeypatch, tmp_path):
    seen = []
    def post(*args, **kwargs):
        seen.extend(kwargs['json']['events'])
        return response()
    monkeypatch.setattr(httpx, 'post', post)
    run = RunClient(spool_dir=tmp_path).init('test', 'backfill')
    run.log({'train/loss': 2.3}, step=28500, event_id='source-event',
            timestamp='2026-10-07T00:00:00+00:00')
    assert run.finish(timeout=2)
    event = next(e for e in seen if e['id'] == 'source-event')
    assert event['timestamp'] == '2026-10-07T00:00:00+00:00'
    assert event['payload']['step'] == 28500
