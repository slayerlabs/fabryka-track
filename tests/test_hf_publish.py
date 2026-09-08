import hashlib
import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import torch
from huggingface_hub.errors import HfHubHTTPError
from safetensors.torch import load_file
from sqlalchemy import select

from fabryka_track import hf_publish as publish, huggingface_auth as auth
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, HFPublication, HuggingFaceIdentity, OAuthAttempt, Run
from test_training import finished, launch


def linked_run(client):
    user=client.get('/api/auth/me').json()['user']
    with SessionLocal() as db:
        db.add(HuggingFaceIdentity(subject='hf-owner',account_id=user['id'],username='hf-owner'))
        db.commit()
    dataset=client.post('/api/datasets',files={'file':('confidential-corpus.txt',b'A private training passage. '*50)}).json()
    return finished(client,launch(client,mix=[{'dataset_id':dataset['id'],'weight':100}]).json()['id'])


def prepare(client, run, name='export-test'):
    result=client.post('/api/training/'+run['id']+'/huggingface',json={'repo_name':name,'private':True,'confirm':True})
    assert result.status_code==200,result.text
    params=parse_qs(urlparse(result.json()['url']).query)
    assert 'contribute-repos' in params['scope'][0]
    assert 'write-repos' not in params['scope'][0]
    return params['state'][0]


def callback(client,state):
    return client.get('/api/auth/huggingface/callback',params={'state':state,'code':'test-code'},follow_redirects=False)


def mock_hub(monkeypatch, remote, conflict=False, corrupt=False):
    class Hub:
        def __init__(self,token): assert token=='transient-upload-token'
        def create_repo(self,**kw):
            assert kw=={'repo_id':'SlayerLab/export-test','repo_type':'model','private':True,'exist_ok':False}
            if conflict: raise HfHubHTTPError('conflict',response=httpx.Response(409,request=httpx.Request('POST','https://huggingface.co/api/repos/create')))
        def upload_folder(self,**kw):
            assert kw['repo_id']=='SlayerLab/export-test'
            remote.update({p.name:p.read_bytes() for p in Path(kw['folder_path']).iterdir()})
            return type('Commit',(),{'oid':'a'*40})()
    def download(**kw):
        assert kw['revision']=='a'*40
        path=Path(kw['local_dir'])/kw['filename'];path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(b'corrupt' if corrupt else remote[kw['filename']])
        return str(path)
    monkeypatch.setattr(publish,'HfApi',Hub)
    monkeypatch.setattr(publish,'hf_hub_download',download)
    monkeypatch.setattr(auth,'fetch_grant',lambda *args:({'sub':'hf-owner'},'transient-upload-token'))


def test_export_round_trip_and_no_private_data(client,monkeypatch,tmp_path):
    run=linked_run(client);remote={};mock_hub(monkeypatch,remote)
    state=prepare(client,run)
    result=callback(client,state)
    assert result.status_code==303
    assert result.headers['location']=='/#run/'+run['id']
    state=client.get('/api/training/'+run['id']+'/huggingface').json()['publication']
    assert state['status']=='finished' and state['commit']=='a'*40
    assert state['url']=='https://huggingface.co/SlayerLab/export-test'
    assert sorted(remote)==sorted(publish.FILES)
    for name,data in remote.items(): (tmp_path/name).write_bytes(data)
    text=''.join(v.decode() for k,v in remote.items() if k.endswith(('.json','.md','.py','.txt')))
    assert 'confidential-corpus' not in text
    assert run['config']['mix'][0]['id'] not in text
    assert run['config']['mix'][0]['sha256'] not in text
    assert 'transient-upload-token' not in text
    manifest=json.loads(remote['export.json'])
    for name,sha in manifest['sha256'].items(): assert hashlib.sha256(remote[name]).hexdigest()==sha
    # Exported architecture and weights must actually reproduce the trained checkpoint.
    spec=importlib.util.spec_from_file_location('exported_model',tmp_path/'modeling_fabryka.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    model=module.TinyTransformer(**json.loads(remote['config.json'])['architecture']).eval()
    model.load_state_dict(load_file(str(tmp_path/'model.safetensors')))
    with SessionLocal() as db:
        checkpoint=torch.load(publish.checkpoint_path(db,db.get(Run,run['id'])),weights_only=True)
        original=module.TinyTransformer(**json.loads(remote['config.json'])['architecture']).eval()
        original.load_state_dict(checkpoint['state_dict'])
        assert torch.equal(model(torch.tensor([[1,2,3]])),original(torch.tensor([[1,2,3]])))
        assert list(db.scalars(select(OAuthAttempt)))==[]
    assert client.post('/api/training/'+run['id']+'/huggingface',json={'repo_name':'another','confirm':True}).status_code==409


@pytest.mark.parametrize('conflict,corrupt',[(True,False),(False,True)])
def test_failed_upload_never_reports_success(client,monkeypatch,conflict,corrupt):
    run=linked_run(client);remote={};mock_hub(monkeypatch,remote,conflict,corrupt)
    assert callback(client,prepare(client,run)).status_code==303
    state=client.get('/api/training/'+run['id']+'/huggingface').json()['publication']
    assert state['status']=='failed' and state['url'] is None and state['commit'] is None
    if conflict: assert 'already exists' in state['error'] and not remote


def test_wrong_hf_identity_and_cancelled_export(client,monkeypatch):
    run=linked_run(client)
    monkeypatch.setattr(auth,'fetch_grant',lambda *args:({'sub':'someone-else'},'wrong-token'))
    assert callback(client,prepare(client,run)).status_code==400
    assert client.get('/api/training/'+run['id']+'/huggingface').json()['publication']['status']=='failed'
    state=prepare(client,run)
    assert client.get('/api/auth/huggingface/callback',params={'state':state,'error':'access_denied'}).status_code==400
    assert client.get('/api/training/'+run['id']+'/huggingface').json()['publication']['status']=='failed'


def test_publish_access_and_preview(client):
    run=finished(client,launch(client).json()['id'])
    path='/api/training/'+run['id']+'/huggingface'
    assert client.get(path).json()['organization']=='SlayerLab'
    assert client.get(path).json()['hf_username'] is None
    assert client.post(path,json={'repo_name':'export-test','confirm':True}).status_code==409
    assert client.post(path,json={'repo_name':'OtherOrg/name','confirm':True}).status_code==422
    assert client.post(path,json={'repo_name':'name'}).status_code==422
    assert client.post(path,json={'repo_name':'name','confirm':False}).status_code==422
    client.post('/api/auth/logout')
    client.post('/api/auth/register',json={'username':'another-user','password':'another-password-123'})
    assert client.get(path).status_code==404
    assert client.post(path,json={'repo_name':'export-test','confirm':True}).status_code==404


def test_published_run_has_public_read_only_details(client):
    run=finished(client,launch(client).json()['id'])
    client.patch('/api/runs/'+run['id']+'/notes',json={'note':'private-note-marker','conclusion':'private-conclusion'})
    client.patch('/api/training/'+run['id']+'/visibility',json={'is_public':True})
    client.post('/api/auth/logout')
    detail=client.get('/api/runs/'+run['id'])
    assert detail.status_code==200
    data=detail.json()
    assert data['read_only'] and data['metrics']['val/loss']
    assert data['logs']==[] and data['artifacts']==[]
    assert 'private-note-marker' not in detail.text
    assert 'sha256' not in detail.text and 'hostname' not in detail.text
    assert client.get('/api/training/'+run['id']+'/manifest').status_code==401
