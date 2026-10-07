from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import sign_in
from fabryka_track.account_admin import transfer_run
from fabryka_track.accounts import digest
from fabryka_track.api import app
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Run, RunSDKToken
from test_api import event


def transferred(client, tmp_path):
    run_id = str(uuid4())
    assert client.post('/api/events', json={'events':[event('run.init', {'run_id':run_id,'name':'Transfer','project':'SDK'})]}).status_code == 200
    client.post('/api/auth/api-key', json={})
    with TestClient(app, headers={'X-Track-Request':'1'}) as other:
        sign_in(other, 'recipient')
        other.post('/api/auth/api-key', json={})
    with SessionLocal() as db:
        key_before = db.scalar(select(Account).where(Account.username == 'recipient')).api_key_hash
        result = transfer_run(db, 'recipient', run_id, tmp_path/'credential.env')
        assert result['username'] == 'recipient'
        assert db.scalar(select(Account).where(Account.username == 'recipient')).api_key_hash == key_before
    path = tmp_path/'credential.env'
    assert path.stat().st_mode & 0o777 == 0o600
    token = dict(line.split('=',1) for line in path.read_text().splitlines())['FABRYKA_API_KEY']
    return run_id, token


def test_transfer_preserves_keys_and_scopes_sdk_to_one_run(client, tmp_path):
    run_id, token = transferred(client, tmp_path)
    assert client.get('/api/runs/'+run_id).json()['read_only'] is True
    with TestClient(app, headers={'Authorization':'Bearer '+token}) as sdk:
        assert sdk.post('/api/events',json={'events':[event('run.metrics',{'run_id':run_id,'step':12,'metrics':{'loss':2}})]}).status_code == 200
        assert sdk.post('/api/runs/'+run_id+'/artifacts',files={'file':('receipt.txt',b'ok')}).status_code == 200
        assert sdk.get('/api/runs/'+run_id).json().get('read_only', False) is False
        assert sdk.get('/api/projects').status_code == 401
        assert sdk.post('/api/auth/api-key',json={}).status_code == 401
        alien = str(uuid4())
        valid = event('run.metrics',{'run_id':run_id,'step':20,'metrics':{'loss':7}})
        invalid = event('run.init',{'run_id':alien,'name':'Forbidden','project':'SDK'})
        assert sdk.post('/api/events',json={'events':[valid,invalid]}).status_code == 403
        assert max(p['step'] for p in sdk.get('/api/runs/'+run_id).json()['metrics']['loss']) == 12
        assert sdk.post('/api/runs/'+alien+'/artifacts',files={'file':('x',b'x')}).status_code == 401
        with SessionLocal() as db:
            stored = db.get(RunSDKToken,digest(token))
            assert stored.key_hash != token
            stored.expires_at = datetime.now(timezone.utc)-timedelta(seconds=1)
            db.commit()
        assert sdk.post('/api/events',json={'events':[valid]}).status_code == 401


def test_token_revoked_by_owner_change_and_transfer_is_exclusive(client, tmp_path):
    run_id, token = transferred(client, tmp_path)
    with SessionLocal() as db:
        old_owner = db.scalar(select(Account).where(Account.username=='tester'))
        run = db.get(Run,run_id)
        run.owner_id = old_owner.id
        db.commit()
        import pytest
        with pytest.raises(FileExistsError):
            transfer_run(db, 'recipient', run_id, tmp_path/'credential.env')
        assert db.get(Run,run_id).owner_id == old_owner.id
    with TestClient(app,headers={'Authorization':'Bearer '+token}) as sdk:
        assert sdk.get('/api/runs/'+run_id).json()['read_only'] is True
        assert sdk.post('/api/events',json={'events':[event('run.finish',{'run_id':run_id})]}).status_code == 401
