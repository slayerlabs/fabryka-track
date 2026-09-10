import httpx
from fabryka_track.provider_diagnostics import response_details
from fabryka_track import gpu_training as gpu


def test_provider_diagnostics_redacts_bounds_and_preserves_error():
    response = httpx.Response(500, text='capacity unavailable Bearer secret-key hf_abcdef "TRACK_RUN_TOKEN":"run-secret" ' + 'x' * 5000)
    result = response_details(response, ['secret-key', 'run-secret'])
    assert 'capacity unavailable' in result
    assert 'secret-key' not in result and 'run-secret' not in result and 'hf_abcdef' not in result
    assert len(result) < 2300


def test_runpod_logs_response_without_request_credentials(monkeypatch, caplog):
    monkeypatch.setattr(gpu.settings, 'runpod_api_key', 'provider-secret')
    transport = httpx.MockTransport(lambda request: httpx.Response(500, json={'error': 'capacity unavailable', 'token': 'run-secret'}))
    original = httpx.Client
    monkeypatch.setattr(gpu.httpx, 'Client', lambda **kw: original(transport=transport, **kw))
    import pytest
    with pytest.raises(httpx.HTTPStatusError):
        gpu.provider('POST', '/pods', json={'name': 'fabryka-track-test', 'env': {'TRACK_RUN_TOKEN': 'run-secret'}})
    assert 'capacity unavailable' in caplog.text
    assert 'fabryka-track-test' in caplog.text
    assert 'run-secret' not in caplog.text and 'provider-secret' not in caplog.text
