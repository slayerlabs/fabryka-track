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
    first,_=create(client,monkeypatch)
    monkeypatch.setattr(settings,'runpod_max_concurrent',1)
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


def test_parallel_dispatch_up_to_cap(client,monkeypatch):
    first,_=create(client,monkeypatch)
    monkeypatch.setattr(settings,'runpod_max_concurrent',2)
    second=launch(client).json()['id']
    calls=[]
    def provider(method,path,**kw):
        calls.append((method,path));return {'id':'second-pod'}
    monkeypatch.setattr(gpu,'provider',provider);gpu.advance(second)
    assert ('POST','/pods') in calls
    with SessionLocal() as s:assert s.get(GPUJob,second).pod_id=='second-pod'


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
    assert calls==['POST','GET','GET','POST']


def test_price_cap_terminates_overpriced_pod(client,monkeypatch):
    rid,_=create(client,monkeypatch);calls=[]
    def provider(method,path,**kw):
        calls.append(method)
        return {'desiredStatus':'RUNNING','costPerHr':settings.runpod_max_hourly_usd+.01}
    monkeypatch.setattr(gpu,'provider',provider);gpu.advance(rid)
    assert calls==['GET','DELETE']
    assert client.get('/api/runs/'+rid).json()['state']=='failed'
