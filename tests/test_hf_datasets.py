import hashlib
import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fabryka_track import hf_datasets as hf
from fabryka_track.database import SessionLocal
from fabryka_track.models import Dataset, DatasetImport


def spec(**changes):
    return hf.ImportSpec(**{'repo':'example/corpus', **changes})


def test_filters_dedup_boundaries_and_size():
    body=spec(min_chars=1,contains='cat',excludes='spam',rules=[{'column':'language','operator':'equals','value':'pl'}, {'column':'score','operator':'gte','value':'3'}])
    rows=[{'text':'Cat\n\nstory','language':'pl','score':3}, {'text':'Cat\n\nstory','language':'pl','score':3},
          {'text':'cat spam','language':'pl','score':4}, {'text':'cat','language':'en','score':4},
          {'text':'cat','language':'pl','score':'nan'}, {'text':None,'language':'pl','score':4}]
    content,stats=hf.collect(rows,body)
    assert content=='Cat\nstory' and stats['accepted']==1 and stats['duplicates']==1
    content,stats=hf.collect([{'text':str(i)+'x'*249999} for i in range(9)],spec(min_chars=1,max_chars=250000,max_mb=1))
    assert len(content.encode())<=1000000 and stats['stop_reason']=='size_limit'
    _,stats=hf.collect([{'text':'no'}]*20,spec(min_chars=100),row_limit=10)
    assert stats['scanned']==10 and stats['stop_reason']=='scan_limit'


def test_source_validation_and_explicit_public_access(monkeypatch):
    for repo in ['http://localhost/data','https://example.com/datasets/a/b','a/../b','/tmp/data','https://huggingface.co/datasets/a/b?x=1']:
        with pytest.raises(ValidationError):spec(repo=repo)
    assert hf.Source(repo='https://huggingface.co/datasets/a/b/').repo=='a/b'
    calls=[]
    class API:
        def __init__(self,token):calls.append(token)
        def dataset_info(self,*a,**kw):return SimpleNamespace(private=False,gated=False,sha='a'*40)
    monkeypatch.setattr(hf,'HfApi',API)
    assert hf.pin(spec()).revision=='a'*40 and calls==[False]
    with pytest.raises(ValidationError):spec(rules=[{'column':'x','operator':'gte','value':'NaN'}])
    with pytest.raises(ValueError,match='Unknown columns'):hf.collect([{'other':'x'}],spec())


def test_import_persists_filters_and_owner_and_is_trainable(client,monkeypatch):
    monkeypatch.setattr(hf,'pin',lambda s:s.model_copy(update={'revision':'b'*40}))
    rows=[{'text':f'Document {i}: '+('A varied training passage with useful words. '*120),'language':'pl'} for i in range(10)]
    monkeypatch.setattr(hf,'stream',lambda s:iter(rows))
    payload={'repo':'example/corpus','rules':[{'column':'language','operator':'equals','value':'pl'}]}
    response=client.post('/api/hf-datasets/imports',json=payload)
    assert response.status_code==202
    for _ in range(100):
        result=client.get('/api/hf-datasets/imports').json()[0]
        if result['state'] not in hf.ACTIVE:break
        time.sleep(.02)
    assert result['state']=='finished',result
    dataset=next(d for d in client.get('/api/datasets').json() if d['id']==result['dataset_id'])
    assert dataset['source']['revision']=='b'*40 and dataset['source']['rules']==payload['rules']
    content=client.get('/api/datasets/'+dataset['id']+'/content').content
    assert hashlib.sha256(content).hexdigest()==dataset['sha256']
    assert dataset['source']['storage']=='file'
    with SessionLocal() as db:
        assert db.get(Dataset,dataset['id']).content==''
    part=client.get('/api/datasets/'+dataset['id']+'/content',headers={'Range':'bytes=0-99'})
    assert part.status_code==206 and part.content==content[:100]
    assert client.get('/api/datasets/'+dataset['id']+'/content?preview=true').content==content[:2000000]
    from test_training import launch,finished
    run=finished(client,launch(client,mix=[{'dataset_id':dataset['id'],'weight':100}],lr_schedule='trapezoidal').json()['id'])
    assert run['state']=='finished'
    assert run['config']['mix'][0]['source']['revision']=='b'*40
    rates=run['metrics']['train/learning_rate']
    assert rates[-1]['value']==pytest.approx(.003*.05)
    from conftest import sign_in
    sign_in(client,'another-owner')
    assert client.get('/api/hf-datasets/imports').json()==[]
    assert client.get('/api/datasets/'+dataset['id']+'/content').status_code==404


def test_failed_import_creates_no_dataset_and_restart_recovers(client,monkeypatch):
    with SessionLocal() as db:
        job=DatasetImport(owner_id='x',config=spec().model_dump());db.add(job);db.commit();jid=job.id
    monkeypatch.setattr(hf,'stream',lambda s:iter([{'text':'too short'}]))
    hf.run_import(jid)
    with SessionLocal() as db:
        job=db.get(DatasetImport,jid);assert job.state=='failed' and job.dataset_id is None
    hf.stop_importer()
    with SessionLocal() as db:
        job.state='running';db.merge(job);db.commit()
    hf.start_importer()
    with SessionLocal() as db:assert db.get(DatasetImport,jid).state=='failed'


def test_hub_card_cannot_redirect_import_to_external_data(monkeypatch):
    class API:
        def __init__(self, **kw): pass
        def dataset_info(self, *a, **kw):
            return SimpleNamespace(private=False,gated=False,sha='c'*40,
                card_data=SimpleNamespace(to_dict=lambda:{'configs':[{'data_files':[{'split':'train','path':'http://127.0.0.1/private.json'}]}]}))
    monkeypatch.setattr(hf,'HfApi',API)
    with pytest.raises(ValueError,match='external'):hf.pin(spec())


def test_large_import_streams_without_returning_content(tmp_path):
    body=spec(max_mb=3000)
    assert spec(max_mb=5000).max_mb==5000
    with pytest.raises(ValidationError):spec(max_mb=5001)
    path=tmp_path/'corpus'
    rows=[{'text':f'Document {i} '+('words '*100)} for i in range(20)]
    expected,stats=hf.collect(rows,body)
    with path.open('wb') as output:
        content,streamed=hf.collect(rows,body,output=output)
    assert content is None and streamed==stats
    assert path.read_bytes()==expected.encode()


def test_ivme_mix_composes_one_chinchilla_sized_dataset_from_all_six_sources(client,monkeypatch):
    monkeypatch.setattr(hf,'pin',lambda s:s.model_copy(update={'revision':'c'*40}))
    def fake_stream(s):
        column='story' if s.repo=='SimpleStories/SimpleStories' else 'text'
        return iter([{column:f'{s.repo} document {i}: '+('useful training words. '*80)} for i in range(40)])
    monkeypatch.setattr(hf,'stream',fake_stream)
    from fabryka_track.gpu_training import PRESETS
    response=client.post('/api/hf-datasets/ivme-mix',json={'model_size':'8m'})
    assert response.status_code==202
    assert response.json()['config']['target_tokens']==20*PRESETS['8m']['parameters']
    for _ in range(200):
        result=client.get('/api/hf-datasets/imports').json()[0]
        if result['state'] not in hf.ACTIVE:break
        time.sleep(.02)
    assert result['state']=='finished',result
    dataset=next(d for d in client.get('/api/datasets').json() if d['id']==result['dataset_id'])
    source=dataset['source']
    assert source['kind']=='mix' and source['recipe']=='ivme-v3-en' and source['target_model_size']=='8m'
    assert source['storage']=='file'
    assert [c['name'] for c in source['components']]==[s['name'] for s in hf.IVME_SOURCES]
    assert [c['weight'] for c in source['components']]==[s['weight'] for s in hf.IVME_SOURCES]
    assert all(c['bytes']>0 for c in source['components'])
    content=client.get('/api/datasets/'+dataset['id']+'/content').content.decode()
    for source_item in hf.IVME_SOURCES:
        assert source_item['repo'] in content
    assert dataset['bytes']==sum(c['bytes'] for c in source['components'])+2*5
    from test_training import launch,finished
    run=finished(client,launch(client,mix=[{'dataset_id':dataset['id'],'weight':100}],lr_schedule='trapezoidal').json()['id'])
    assert run['state']=='finished'
