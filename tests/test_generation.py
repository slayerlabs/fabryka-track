from conftest import sign_in
import json
import subprocess
from types import SimpleNamespace
import pytest
import torch
from fabryka_track.generation_worker import CachedDecoder, sample
from fabryka_track.native_model import TinyTransformer
from test_training import finished, launch

def test_samples_are_actual_checkpoint_outputs_and_reproducible(tmp_path):
    cfg=dict(width=8,layers=1,heads=2,context_length=8)
    model=TinyTransformer(**cfg)
    with torch.no_grad():
        for p in model.parameters():p.zero_()
        model.norm.bias.fill_(1)
        model.head.weight[65].fill_(1)
    path=tmp_path/'model.pt'
    torch.save(dict(config=cfg,state_dict=model.state_dict(),best_step=7),path)
    options=dict(prompt='long prompt here',max_new_bytes=4,temperature=0,top_k=40,seed=42)
    result=sample(path,options)
    assert result['continuation']=='AAAA'
    assert result['prompt_truncated'] and result['checkpoint_step']==7
    assert len(result['checkpoint_sha256'])==64
    options['temperature']=.8
    assert sample(path,options)['raw_bytes_hex']==sample(path,options)['raw_bytes_hex']

def test_generation_permissions_limits_and_busy_slot(client,monkeypatch):
    from fabryka_track import generation
    run=finished(client,launch(client).json()['id'])
    url='/api/runs/'+run['id']+'/generate'
    assert client.post(url,json={'prompt':'hello','max_new_bytes':513}).status_code==422
    generation._slot.acquire()
    try:assert client.post(url,json={'prompt':'hello'}).status_code==429
    finally:generation._slot.release()
    client.post('/api/auth/logout')
    assert client.post(url,json={'prompt':'hello'}).status_code==401
    sign_in(client, 'other')
    response = client.post(url,json={'prompt':'hello', 'max_new_bytes':4})
    assert response.status_code == 200
    assert response.json()['generated_bytes'] == 4
    assert len(response.json()['checkpoint_sha256']) == 64
    assert client.patch('/api/runs/'+run['id']+'/notes', json={'note':'changed','conclusion':''}).status_code == 404
    assert client.patch('/api/training/'+run['id']+'/visibility', json={'is_public':False}).status_code == 404
    artifact = run['artifacts'][0]['id']
    assert client.get('/api/artifacts/'+artifact).status_code == 404
    sign_in(client)
    assert client.patch('/api/training/'+run['id']+'/visibility', json={'is_public':False}).status_code == 200
    assert client.post(url,json={'prompt':'hello', 'max_new_bytes':1}).status_code == 200
    sign_in(client, 'other')
    assert client.post(url,json={'prompt':'hello'}).status_code == 404


@pytest.mark.parametrize('cfg', [dict(width=8,layers=1,heads=2,context_length=8),
                               dict(width=24,layers=3,heads=4,context_length=16)])
@pytest.mark.parametrize('prefix_length', [1, 5, 23])
def test_cached_logits_match_full_causal_model_across_sliding_windows(cfg, prefix_length):
    torch.manual_seed(73)
    model = TinyTransformer(**cfg).eval()
    decoder = CachedDecoder(model)
    tokens = torch.randint(0, 256, (prefix_length,)).tolist()
    with torch.inference_mode():
        for _ in range(cfg['context_length'] + 3):
            expected = model(torch.tensor([tokens[-cfg['context_length']:]]))[0, -1]
            actual = decoder.next_logits(tokens)
            torch.testing.assert_close(actual, expected, rtol=2e-5, atol=2e-6)
            tokens.append(expected.argmax().item())


def test_time_budget_returns_partial_checkpoint_output(tmp_path):
    cfg = dict(width=8,layers=1,heads=2,context_length=8)
    path = tmp_path/'model.pt'
    torch.save(dict(config=cfg, state_dict=TinyTransformer(**cfg).state_dict()), path)
    options = dict(prompt='test', max_new_bytes=4, temperature=0, top_k=40, seed=42)
    partial = sample(path, options, time_budget_seconds=0)
    full = sample(path, options)
    assert partial['finish_reason'] == 'time_limit'
    assert partial['generated_bytes'] == 1
    assert full['raw_bytes_hex'].startswith(partial['raw_bytes_hex'])
    assert full['finish_reason'] == 'length'


def test_failed_workers_release_generation_slot(client, monkeypatch):
    from fabryka_track import generation
    run = finished(client,launch(client).json()['id'])
    url = '/api/runs/'+run['id']+'/generate'
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 90)
    monkeypatch.setattr(generation.subprocess, 'run', timeout)
    assert client.post(url, json={'prompt':'hello'}).status_code == 504
    monkeypatch.setattr(generation.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=1))
    assert client.post(url, json={'prompt':'hello'}).status_code == 503
    monkeypatch.setattr(generation.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps({'continuation':'ok'})))
    assert client.post(url, json={'prompt':'hello'}).status_code == 200


@pytest.mark.parametrize('condition', ['unfinished', 'unsupported', 'missing_checkpoint'])
def test_unavailable_public_models_do_not_start_a_worker(client, monkeypatch, condition):
    from fabryka_track import generation
    from fabryka_track.database import SessionLocal
    from fabryka_track.models import Run
    run = finished(client, launch(client).json()['id'])
    with SessionLocal() as session:
        stored = session.get(Run, run['id'])
        if condition == 'unfinished':
            stored.state = 'running'
        elif condition == 'unsupported':
            stored.metadata_ = {'engine': 'external'}
        else:
            generation.checkpoint_path(session, stored).unlink()
        session.commit()
    def unexpected_worker(*args, **kwargs):
        pytest.fail('An unavailable model must not start a worker')
    monkeypatch.setattr(generation.subprocess, 'run', unexpected_worker)
    sign_in(client, 'other')
    response = client.post('/api/runs/'+run['id']+'/generate', json={'prompt':'hello'})
    assert response.status_code == (404 if condition == 'unfinished' else 409)
