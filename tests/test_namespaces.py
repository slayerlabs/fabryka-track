from conftest import sign_in
import json
from uuid import uuid4

from fabryka_track.client import RunClient
from test_api import event


def sdk_run(client):
    rid=str(uuid4())
    assert client.post('/api/events',json={'events':[event('run.init',{'run_id':rid,'project':'research','name':'namespace research'})]}).status_code==200
    return rid


def test_mutable_subtree_and_field_type_conflicts(client):
    rid=sdk_run(client);base='/api/runs/'+rid
    assert client.put(base+'/attributes/config/model',json={'value':{'hidden_size':256,'layers':10}}).status_code==200
    assert client.get(base+'/attributes/config/model/hidden_size').json()['value']==256
    client.put(base+'/attributes/config/model/hidden_size',json={'value':512})
    assert client.get(base+'/attributes/config/model').json()['value']=={'hidden_size':512,'layers':10}
    assert client.post(base+'/series',json={'config/model/hidden_size':[[1,5.0]]}).status_code==409
    assert client.post(base+'/series',json={'train/loss':[[1,4.12],[2,3.97]]}).json()['accepted']==2
    assert client.put(base+'/attributes/train',json={'value':{'loss':1}}).status_code==409
    assert client.put(base+'/attributes/config/model',json={'value':{'new_architecture':True}}).status_code==200
    assert client.get(base+'/attributes/config/model').json()['value']=={'new_architecture':True}
    assert client.put(base+'/attributes/bad//path',json={'value':1}).status_code==422


def test_series_cursor_and_namespace_prefix_are_bounded_and_private(client):
    rid=sdk_run(client);base='/api/runs/'+rid
    client.post(base+'/series',json={'train/loss':[[1,4],[2,3],[3,2]],'eval/custom/f1':[[1,.7]]})
    page=client.get(base+'/series',params={'path':'train/loss','limit':2}).json()
    assert [p['value'] for p in page['points']]==[4,3]
    more=client.get(base+'/series',params={'path':'train/loss','limit':2,'after':page['next_cursor']}).json()
    assert [p['value'] for p in more['points']]==[2] and more['next_cursor'] is None
    first=client.get(base+'/namespace',params={'limit':1}).json()
    second=client.get(base+'/namespace',params={'after':first['next_cursor'],'limit':1}).json()
    assert first['items'][0]['path']=='eval/custom/f1' and second['items'][0]['path']=='train/loss'
    assert client.get(base+'/namespace',params={'prefix':'train/'}).json()['items']==[{'path':'train/loss','kind':'series'}]
    assert client.get(base+'/series',params={'path':'train/loss','limit':10001}).status_code==422
    client.post('/api/auth/logout')
    assert client.get(base+'/namespace').status_code==401
    sign_in(client, 'other')
    assert client.get(base+'/namespace').status_code==404
    assert client.post(base+'/series',json={'train/loss':[[4,1]]}).status_code==404
    assert client.get('/api/benchmarks/evaluations').json()['items']==[]


def test_artifact_alias_is_mutable_but_old_blob_is_preserved(client):
    rid=sdk_run(client);base='/api/runs/'+rid
    a=client.post(base+'/artifacts',data={'namespace':'checkpoints/latest'},files={'file':('model.bin',b'first')}).json()
    b=client.post(base+'/artifacts',data={'namespace':'checkpoints/latest'},files={'file':('model.bin',b'second')}).json()
    item=client.get(base+'/namespace',params={'prefix':'checkpoints/'}).json()['items'][0]
    assert item['artifact_id']==b['id'] and a['id']!=b['id']
    assert client.get('/api/artifacts/'+a['id']).content==b'first'
    assert client.get('/api/artifacts/'+b['id']).content==b'second'


def test_sdk_namespace_events_are_replayable(client,tmp_path,monkeypatch):
    tracker=RunClient(api_url='http://127.0.0.1:1',spool_dir=tmp_path)
    monkeypatch.setattr(tracker,'_start_workers',lambda:None)
    monkeypatch.setattr('fabryka_track.client._metadata',lambda:{})
    tracker.init('research','SDK namespace')
    tracker['config/model']={'hidden_size':256,'layers':10}
    tracker['train/loss'].append(4.12,step=1024)
    tracker['eval/mmlu/accuracy']=.673
    artifact=tmp_path/'checkpoint.bin';artifact.write_bytes(b'weights')
    tracker['checkpoints/latest'].upload(artifact)
    events=[json.loads(p.read_text()) for p in sorted(tmp_path.glob('*.jsonl'))]
    uploads=[e for e in events if e['type']=='run.artifact']
    assert uploads[0]['payload']['namespace']=='checkpoints/latest'
    records=[e for e in events if e['type']!='run.artifact']
    for _ in range(2):assert client.post('/api/events',json={'events':records}).status_code==200
    base='/api/runs/'+tracker.run_id
    assert client.get(base+'/attributes/config/model').json()['value']=={'hidden_size':256,'layers':10}
    assert len(client.get(base+'/series',params={'path':'train/loss'}).json()['points'])==1
    tracker.run_id=None
