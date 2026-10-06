import pytest
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Dataset
from fabryka_track.settings import settings
from sqlalchemy import select


def test_removed_payload_keeps_metadata_and_returns_gone(client):
    with SessionLocal() as db:
        user = db.scalar(select(Account).where(Account.username == 'tester'))
        row = Dataset(owner_id=user.id, name='Retained corpus metadata', content='',
                      byte_count=3000000000, sha256='a'*64,
                      source={'repo':'example/corpus','storage':'file','content_available':False})
        db.add(row); db.commit(); dataset_id=row.id
    rows=client.get('/api/datasets').json()
    retained=next(d for d in rows if d['id']==dataset_id)
    assert retained['bytes']==3000000000 and retained['source']['repo']=='example/corpus'
    for query in ('', '?preview=true'):
        response=client.get(f'/api/datasets/{dataset_id}/content{query}')
        assert response.status_code==410
    response=client.post('/api/training',json={'name':'Unavailable dataset training','mix':[{'dataset_id':dataset_id,'weight':100}]})
    assert response.status_code==410


def test_tracking_server_rejects_dataset_storage_without_starting_import(client, monkeypatch):
    monkeypatch.setattr(settings,'dataset_storage_enabled',False)
    monkeypatch.setattr('fabryka_track.hf_datasets.pin',lambda _:pytest.fail('Disabled importer contacted the Hub'))
    assert client.post('/api/hf-datasets/imports',json={'repo':'example/corpus'}).status_code==503
    assert client.post('/api/hf-datasets/ivme-mix',json={}).status_code==503
    assert client.post('/api/datasets',files={'file':('sample.txt',b'x'*200)}).status_code==503
    assert client.get('/api/datasets').status_code==200
    assert client.get('/health').status_code==200
