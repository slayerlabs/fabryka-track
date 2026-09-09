from conftest import sign_in
import io
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from fabryka_track.api import app
from fabryka_track.accounts import COOKIE, digest, _attempts
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, AccountSession, Dataset, Run
from test_api import event
from test_training import launch, finished


def test_hf_only_sessions_and_csrf(client):
    assert client.get('/api/auth/me').json()['user']['username'] == 'tester'
    cookie = client.cookies.get(COOKIE)
    with SessionLocal() as db:
        user = db.scalar(select(Account))
        assert user.password_hash == ''
        assert db.get(AccountSession, cookie) is None
        assert db.get(AccountSession, digest(cookie)) is not None
    for path,body in [('/login',{'username':'tester','password':'testing-password-123'}),
                      ('/register',{'username':'new-user','password':'testing-password-123'}),
                      ('/password',{'current_password':'','new_password':'testing-password-123'})]:
        assert client.post('/api/auth'+path,json=body).status_code == 405
    assert client.post('/api/auth/logout', headers={'X-Track-Request':''}).status_code == 403
    assert client.post('/api/auth/logout', headers={'Origin':'https://evil.example'}).status_code == 403
    assert client.get('/api/auth/me').headers['cache-control'] == 'no-store'
    assert client.post('/api/auth/logout').status_code == 200
    assert client.get('/api/auth/me').json()['user'] is None


def test_two_accounts_are_isolated_and_publication_only_exposes_scores(client):
    uploaded = client.post('/api/datasets', files={'file':('secret-corpus-name.txt', b'This is private text. ' * 50)}).json()
    response = launch(client, mix=[{'dataset_id':uploaded['id'],'weight':100}])
    run = finished(client, response.json()['id'])
    assert run['state'] == 'finished'
    artifact = run['artifacts'][0]['id']
    assert client.get('/api/leaderboard').json()['sizes'][0]['models'][0]['owner'] == 'tester'
    with TestClient(app, headers={'X-Track-Request': '1'}) as other:
        assert other.get('/api/leaderboard').status_code == 200
        assert other.get('/api/projects').status_code == 401
        assert other.get('/api/runs/' + run['id']).status_code == 200
        sign_in(other,'second')
        assert other.get('/api/projects').json() == []
        assert other.get('/api/projects/Training%20studio/runs').json() == []
        assert uploaded['id'] not in [d['id'] for d in other.get('/api/datasets').json()]
        for path in ['/api/artifacts/' + artifact, '/api/training/' + run['id'] + '/manifest', '/api/datasets/' + uploaded['id'] + '/content']:
            assert other.get(path).status_code == 404
        assert other.get('/api/compare', params=[('ids',run['id']),('ids',run['id'])]).status_code == 200
        assert other.patch('/api/runs/' + run['id'] + '/notes',json={'note':'hacked','conclusion':''}).status_code == 404
        assert other.post('/api/runs/' + run['id'] + '/logs',json={'level':'info','message':'hacked'}).status_code == 404
        assert other.post('/api/runs/' + run['id'] + '/artifacts',files={'file':('model.pt',b'hacked')}).status_code == 404
        assert other.post('/api/training/' + run['id'] + '/stop').status_code == 404
        assert other.patch('/api/training/' + run['id'] + '/visibility',json={'is_public':True}).status_code == 404
        assert launch(other, mix=[{'dataset_id':uploaded['id'],'weight':100}]).status_code == 422
        assert other.post('/api/events',json={'events':[event('run.finish',{'run_id':run['id']})]}).status_code == 404
        duplicate = other.post('/api/datasets', files={'file':('own.txt', b'This is private text. ' * 50)}).json()
        assert duplicate['id'] != uploaded['id']
        board = other.get('/api/leaderboard').json()['sizes'][0]['models']
        assert board[0]['owner'] == 'tester'
        assert board[0]['is_owner'] is False
        assert board[0]['mix'][0]['name'] == 'Private dataset'
        assert 'secret-corpus-name' not in str(board)
        public = other.get('/api/runs/' + run['id']).json()
        assert public['read_only'] is True
        assert public['artifacts'] == [] and public['logs'] == []
        assert 'secret-corpus-name' not in str(public)
        assert public['metrics']['val/loss']
        assert client.patch('/api/training/' + run['id'] + '/visibility',json={'is_public':False}).status_code == 200
        assert other.get('/api/leaderboard').json()['sizes'] == []


def test_api_key_ingestion_revoke_and_studio_metrics_protection(client):
    response = client.post('/api/auth/api-key', json={'password':'testing-password-123'})
    key = response.json()['api_key']
    with TestClient(app, headers={'Authorization': 'Bearer ' + key}) as sdk:
        run_id = str(uuid4())
        response = sdk.post('/api/events', json={'events':[event('run.init',{'run_id':run_id,'name':'SDK','project':'SDK','metadata':{'engine':'tiny-transformer'}})]})
        assert response.status_code == 200
        assert client.get('/api/runs/' + run_id).json()['metadata']['engine'] == 'sdk'
        assert sdk.post('/api/events',json={'events':[event('run.metrics',{'run_id':run_id,'step':0,'metrics':{'loss':2}})]}).status_code == 200
        assert sdk.post('/api/runs/' + run_id + '/artifacts',files={'file':('sdk.txt',b'ok')}).status_code == 200
        studio = finished(client, launch(client).json()['id'])
        assert sdk.post('/api/events',json={'events':[event('run.finish',{'run_id':studio['id']})]}).status_code == 409
        assert client.delete('/api/auth/api-key').status_code == 200
        assert sdk.get('/api/projects').status_code == 401


def test_session_expiry_and_hf_rate_limit(client):
    with SessionLocal() as db:
        stored = db.get(AccountSession,digest(client.cookies.get(COOKIE)))
        stored.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    assert client.get('/api/datasets').status_code == 401
    _attempts.clear()
    for _ in range(30):
        assert client.post('/api/auth/huggingface/start',json={}).status_code == 200
    assert client.post('/api/auth/huggingface/start',json={}).status_code == 429


def test_additive_migration_preserves_legacy_data_and_is_idempotent(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, text, inspect
    from fabryka_track import database
    legacy = create_engine('sqlite:///' + str(tmp_path / 'legacy.db'))
    with legacy.begin() as db:
        db.execute(text('CREATE TABLE runs (id VARCHAR(32) PRIMARY KEY, name TEXT)'))
        db.execute(text("INSERT INTO runs (id, name) VALUES ('old-run', 'Keep this run')"))
        db.execute(text('CREATE TABLE datasets (id VARCHAR(32) PRIMARY KEY, content TEXT)'))
        db.execute(text("INSERT INTO datasets (id, content) VALUES ('old-data', 'Keep this data')"))
    monkeypatch.setattr(database, 'engine', legacy)
    database.create_tables()
    database.create_tables()
    with legacy.connect() as db:
        assert db.execute(text('SELECT name, owner_id, is_public FROM runs')).one() == ('Keep this run', None, 1)
        assert db.execute(text('SELECT content, owner_id FROM datasets')).one() == ('Keep this data', None)
        assert 'accounts' in inspect(db).get_table_names()
    legacy.dispose()
