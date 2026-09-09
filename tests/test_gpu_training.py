import hashlib
from datetime import timedelta
from types import SimpleNamespace

import pytest
import torch

from fabryka_track import gpu_training as gpu
from fabryka_track.database import SessionLocal
from fabryka_track.models import GPUJob,Run
from fabryka_track.native_model import TinyTransformer
from fabryka_track.settings import settings


def enable(monkeypatch):
    monkeypatch.setattr(settings,'runpod_api_key','test-provider-secret')
    monkeypatch.setattr(settings,'runpod_allowed_users','tester')


def launch(client):
    d=client.get('/api/datasets').json()[0]
    return client.post('/api/training',json={'name':'GPU test','compute':'runpod','model_size':'8m','steps':10,
        'mix':[{'dataset_id':d['id'],'weight':100}]})


def create(client,monkeypatch):
    enable(monkeypatch);r=launch(client);assert r.status_code==201,r.text
    rid=r.json()['id'];token='run-only-token'
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.token_hash=hashlib.sha256(token.encode()).hexdigest();j.state='running';j.pod_id='owned-pod';s.commit()
    return rid,{'Authorization':'Bearer '+token}


def test_gpu_parameters_match_real_architecture():
    for preset in gpu.PRESETS.values():
        with torch.device('meta'):m=TinyTransformer(**preset['architecture'])
        assert sum(p.numel() for p in m.parameters())==preset['parameters']


def test_huggingface_connected_accounts_can_use_gpu(monkeypatch):
    monkeypatch.setattr(settings,'runpod_api_key','test-provider-secret')
    monkeypatch.setattr(settings,'runpod_allowed_users','')
    assert gpu.allowed(SimpleNamespace(username='hf-user',huggingface_username='hf-user'))
    assert not gpu.allowed(SimpleNamespace(username='password-only',huggingface_username=None))


def test_gpu_access_no_silent_cpu_fallback(client,monkeypatch):
    assert launch(client).status_code==403
    enable(monkeypatch)
    r=launch(client);assert r.status_code==201
    run=client.get('/api/runs/'+r.json()['id']).json()
    assert run['config']['compute']=='runpod' and run['state']=='queued'
    for _ in range(4):assert launch(client).status_code==201
    assert launch(client).status_code==409
    assert client.post('/api/training',json={'name':'bad','compute':'cpu','model_size':'8m',
      'mix':[{'dataset_id':client.get('/api/datasets').json()[0]['id'],'weight':100}]}).status_code==422


def test_runner_scoped_auth_and_hashes(client,monkeypatch):
    rid,h=create(client,monkeypatch)
    assert client.get('/api/runner/'+rid+'/manifest').status_code==401
    assert client.get('/api/runner/not-this-run/manifest',headers=h).status_code==401
    cfg=client.get('/api/runner/'+rid+'/manifest',headers=h).json()['config']
    other=client.get('/api/datasets').json()[1]['id']
    assert client.get('/api/runner/'+rid+'/datasets/'+other,headers=h).status_code==404
    d=cfg['mix'][0]
    assert hashlib.sha256(client.get('/api/runner/'+rid+'/datasets/'+d['id'],headers=h).content).hexdigest()==d['sha256']
    u='/api/runner/'+rid+'/artifacts/model.pt'
    assert client.put(u,content=b'checkpoint',headers=h|{'X-Content-SHA256':'0'*64}).status_code==422
    assert client.post('/api/runner/'+rid+'/complete',headers=h,json={'state':'finished','files':{},'result':{}}).status_code==409


def test_verified_sync_then_delete_and_callback_idempotency(client,monkeypatch):
    rid,h=create(client,monkeypatch);files={}
    for name in gpu.FILES:
        b=b'artifact-'+name.encode();digest=hashlib.sha256(b).hexdigest();files[name]=digest
        r=client.put('/api/runner/'+rid+'/artifacts/'+name,content=b,headers=h|{'X-Content-SHA256':digest})
        assert r.status_code==200,r.text
    p={'step':1,'values':{'train/loss':3.0,'progress':10},'gpu':'test CUDA'}
    for _ in range(2):assert client.post('/api/runner/'+rid+'/progress',headers=h,json=p).status_code==200
    result={'best_val_loss':3.0,'best_val_perplexity':20.1,'completed_steps':10,'best_step':10,'tokens_seen':1000}
    assert client.post('/api/runner/'+rid+'/complete',headers=h,json={'state':'finished','files':files,'result':result}).status_code==200
    assert client.get('/api/runs/'+rid).json()['state']!='finished'
    calls=[]
    monkeypatch.setattr(gpu,'provider',lambda method,path,**kw:calls.append((method,path)))
    gpu.advance(rid)
    assert calls==[('DELETE','/pods/owned-pod')]
    run=client.get('/api/runs/'+rid).json();assert run['state']=='finished'
    assert len(run['metrics']['train/loss'])==1
    assert client.get('/api/runner/'+rid+'/manifest',headers=h).status_code==410


def test_cleanup_retries_after_provider_failure(client,monkeypatch):
    rid,h=create(client,monkeypatch)
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.deadline=gpu.now()-timedelta(seconds=1);s.commit()
    def fail(method,path,**kw):raise RuntimeError('temporary provider outage')
    monkeypatch.setattr(gpu,'provider',fail);gpu.tick()
    with SessionLocal() as s:assert not s.get(GPUJob,rid).cleanup_done
    calls=[];monkeypatch.setattr(gpu,'provider',lambda method,path,**kw:calls.append((method,path)))
    gpu.advance(rid);assert calls==[('DELETE','/pods/owned-pod')]
    assert client.get('/api/runs/'+rid).json()['state']=='failed'


def test_restart_reconciles_uncertain_create_without_second_pod(client,monkeypatch):
    rid,h=create(client,monkeypatch)
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.pod_id=None;j.state='provisioning';s.commit()
    calls=[]
    def provider(method,path,**kw):
        calls.append((method,path))
        return [{'id':'recovered','name':'fabryka-track-'+rid}] if path=='/pods' else {'desiredStatus':'RUNNING','costPerHr':.27}
    monkeypatch.setattr(gpu,'provider',provider);gpu.advance(rid)
    assert all(method=='GET' for method,path in calls)
    with SessionLocal() as s:assert s.get(GPUJob,rid).pod_id=='recovered'


def test_dispatch_uses_scoped_bundle_and_selected_image(client,monkeypatch):
    enable(monkeypatch);rid=launch(client).json()['id'];calls=[]
    def provider(method,path,**kw):
        calls.append((method,path,kw))
        return {'id':'created-pod'}
    monkeypatch.setattr(gpu,'provider',provider);gpu.advance(rid)
    payload=calls[0][2]['json'];assert payload['imageName']=='dawidmkrk/dmpod-gpt:1.0'
    assert payload['gpuCount']==1 and payload['env']['TRACK_RUN_ID']==rid
    assert 'test-provider-secret' not in str(payload)
    token=payload['env']['TRACK_RUN_TOKEN'];h={'Authorization':'Bearer '+token}
    bundle=client.get('/api/runner/'+rid+'/bundle',headers=h)
    assert hashlib.sha256(bundle.content).hexdigest()==payload['env']['TRACK_BUNDLE_SHA256']
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);assert j.pod_id=='created-pod'
        assert j.token_hash==hashlib.sha256(token.encode()).hexdigest()


def test_queue_waits_without_allocating_or_consuming_runtime(client,monkeypatch):
    monkeypatch.setattr(settings,'runpod_max_parallel',1)
    first,_=create(client,monkeypatch)
    second=launch(client).json()['id']
    def unexpected(*a,**kw):raise AssertionError('Queued run must not contact provider')
    monkeypatch.setattr(gpu,'provider',unexpected)
    gpu.advance(second)
    data=client.get('/api/runs/'+second).json()
    assert data['gpu_status']['queue_position']==2
    assert data['gpu_status']['deadline'] is None
    assert 'token_hash' not in str(data)
    client.post('/api/training/'+second+'/stop')
    gpu.advance(second)
    assert client.get('/api/runs/'+second).json()['state']=='cancelled'


def test_capacity_retry_requires_two_empty_reconciliations(client,monkeypatch):
    import httpx
    enable(monkeypatch);rid=launch(client).json()['id'];calls=[]
    def unavailable(method,path,**kw):
        calls.append(method)
        if method=='POST':
            response=httpx.Response(500,request=httpx.Request('POST','https://provider.invalid'))
            raise httpx.HTTPStatusError('unavailable',request=response.request,response=response)
        return []
    monkeypatch.setattr(gpu,'provider',unavailable)
    gpu.advance(rid)
    assert 'HTTP 500' in client.get('/api/runs/'+rid).json()['gpu_status']['error']
    for expected in ('provisioning','queued'):
        with SessionLocal() as s:
            j=s.get(GPUJob,rid);j.next_retry_at=gpu.now()-timedelta(seconds=1);s.commit()
        gpu.advance(rid)
        with SessionLocal() as s:assert s.get(GPUJob,rid).state==expected
    assert calls==['POST','GET','GET']
    gpu.advance(rid)
    assert calls==['POST','GET','GET']  # Respect the retry cooldown.
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.next_retry_at=gpu.now()-timedelta(seconds=1);s.commit()
    gpu.advance(rid)
    assert calls==['POST','GET','GET','POST']


def test_price_cap_terminates_overpriced_pod(client,monkeypatch):
    rid,_=create(client,monkeypatch);calls=[]
    def provider(method,path,**kw):
        calls.append(method)
        return {'desiredStatus':'RUNNING','costPerHr':settings.runpod_max_hourly_usd+.01}
    monkeypatch.setattr(gpu,'provider',provider);gpu.advance(rid)
    assert calls==['GET','DELETE']
    assert client.get('/api/runs/'+rid).json()['state']=='failed'


def test_fifty_users_parallel_nodes_and_backpressure(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from sqlalchemy import select
    from fabryka_track.accounts import require_user
    from fabryka_track.api import app
    enable(monkeypatch)
    monkeypatch.setattr(settings, 'runpod_allowed_users', '*')
    monkeypatch.setattr(settings, 'runpod_max_parallel', 50)
    monkeypatch.setattr(settings, 'runpod_max_pending', 250)
    dataset = client.get('/api/datasets').json()[0]['id']
    # Exercise real admission concurrently with 50 identities, five runs each.
    def submit_user(i):
        from fabryka_track.training import launch as submit, TrainingInput
        user = SimpleNamespace(id=f'user-{i}', username=f'user-{i}')
        ids = []
        for n in range(5):
            with SessionLocal() as session:
                ids.append(submit(TrainingInput(name=f'{i}-{n}', compute='runpod', model_size='8m',
                    steps=10, mix=[{'dataset_id':dataset, 'weight':100}]), session, user)['id'])
        return ids
    with ThreadPoolExecutor(max_workers=50) as pool:
        ids = [rid for group in pool.map(submit_user, range(50)) for rid in group]
    assert len(ids) == 250
    assert launch(client).status_code == 409
    calls = []; guard = threading.Lock(); overlapping = threading.Barrier(8)
    def provider(method, path, **kw):
        if method == 'POST':
            with guard:
                calls.append(kw['json']['env']['TRACK_RUN_ID'])
                index = len(calls)
            if index <= 8:
                overlapping.wait(timeout=10)  # Fails if dispatch is serialized.
            return {'id': 'pod-' + kw['json']['env']['TRACK_RUN_ID']}
        if method == 'DELETE': return None
        return {'desiredStatus':'RUNNING', 'costPerHr':0.27}
    monkeypatch.setattr(gpu, 'provider', provider)
    gpu.tick()
    with SessionLocal() as session:
        jobs = list(session.scalars(select(GPUJob)))
        assert sum(j.state == 'provisioning' for j in jobs) == 50
        assert sum(j.state == 'queued' for j in jobs) == 200
        assert all(j.error is None for j in jobs)
        finished = next(j for j in jobs if j.pod_id)
        finished.state = 'finished'
        finished_id = finished.run_id
        session.commit()
    assert len(calls) == len(set(calls)) == 50
    gpu.advance(finished_id)
    gpu.tick()
    assert len(calls) == len(set(calls)) == 51


def test_gpu_user_limit_does_not_block_other_users(client, monkeypatch):
    from fabryka_track.accounts import require_user
    from fabryka_track.api import app
    enable(monkeypatch)
    monkeypatch.setattr(settings, 'runpod_allowed_users', '*')
    for _ in range(5): assert launch(client).status_code == 201
    assert launch(client).status_code == 409
    app.dependency_overrides[require_user] = lambda: SimpleNamespace(id='other-user', username='other-user')
    try:
        assert launch(client).status_code == 201
    finally:
        app.dependency_overrides.pop(require_user)


def test_allocation_survives_more_than_three_failures(client,monkeypatch):
    import httpx
    enable(monkeypatch);rid=launch(client).json()['id'];creates=[]
    def provider(method,path,**kw):
        if method=='POST':
            creates.append(kw['json'])
            if len(creates)<=4:
                response=httpx.Response(500,request=httpx.Request('POST','https://provider.invalid'))
                raise httpx.HTTPStatusError('capacity',request=response.request,response=response)
            return {'id':'eventually-available'}
        return []
    monkeypatch.setattr(gpu,'provider',provider)
    for attempt in range(4):
        gpu.advance(rid)
        for _ in range(2):
            with SessionLocal() as s:
                j=s.get(GPUJob,rid);j.next_retry_at=gpu.now()-timedelta(seconds=1);s.commit()
            gpu.advance(rid)
        with SessionLocal() as s:
            j=s.get(GPUJob,rid);assert j.state=='queued' and not j.cleanup_done
            j.next_retry_at=gpu.now()-timedelta(seconds=1);s.commit()
    gpu.advance(rid)
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);assert j.pod_id=='eventually-available' and j.dispatch_attempts==5
    assert len(creates)==5


def test_allocation_wait_has_a_bound_without_allocating(client,monkeypatch):
    enable(monkeypatch);rid=launch(client).json()['id']
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.allocation_deadline=gpu.now()-timedelta(seconds=1);s.commit()
    def unexpected(*a,**kw):raise AssertionError('Allocation budget expired')
    monkeypatch.setattr(gpu,'provider',unexpected)
    gpu.advance(rid)
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);assert j.cleanup_done and j.state=='failed'
        assert 'wait limit' in j.error


def test_cancel_during_allocation_backoff(client,monkeypatch):
    enable(monkeypatch);rid=launch(client).json()['id']
    with SessionLocal() as s:
        j=s.get(GPUJob,rid);j.next_retry_at=gpu.now()+timedelta(minutes=5);s.commit()
    client.post('/api/training/'+rid+'/stop');gpu.advance(rid)
    with SessionLocal() as s:assert s.get(GPUJob,rid).cleanup_done
