import hashlib
from datetime import timedelta

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


def test_gpu_access_no_silent_cpu_fallback(client,monkeypatch):
    assert launch(client).status_code==403
    enable(monkeypatch)
    r=launch(client);assert r.status_code==201
    run=client.get('/api/runs/'+r.json()['id']).json()
    assert run['config']['compute']=='runpod' and run['state']=='queued'
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
