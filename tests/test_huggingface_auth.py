from conftest import sign_in
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from sqlalchemy import select

from fabryka_track.api import app
from fabryka_track.accounts import COOKIE, digest
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, AccountSession, OAuthAttempt, HuggingFaceIdentity
from fabryka_track import huggingface_auth as hf


def begin(client, link=False):
    response = client.post('/api/auth/huggingface/start', json={'link':link})
    assert response.status_code == 200
    params = parse_qs(urlparse(response.json()['url']).query)
    assert params['scope'] == ['openid profile']
    assert params['code_challenge_method'] == ['S256']
    return params['state'][0]


def complete(client, state):
    return client.get('/api/auth/huggingface/callback',params={'state':state,'code':'test-code'},follow_redirects=False)


def test_hf_new_account_repeat_login_and_credentials(client, monkeypatch):
    monkeypatch.setattr(hf, 'fetch_profile', lambda code, verifier: {'sub':'hf-stable-id','preferred_username':'Tester'})
    client.post('/api/auth/logout')
    state = begin(client)
    assert complete(client,state).status_code == 303
    user = client.get('/api/auth/me').json()['user']
    assert user['username'] == 'hf_tester'
    assert not user['has_password']
    assert user['huggingface_username'] == 'Tester'
    assert complete(client,state).status_code == 400
    client.post('/api/auth/logout')
    assert complete(client,begin(client)).status_code == 303
    assert client.get('/api/auth/me').json()['user']['id'] == user['id']
    assert client.post('/api/auth/api-key',json={}).status_code == 200
    assert client.post('/api/auth/password',json={'current_password':'','new_password':'my-new-password-123'}).status_code == 405
    client.post('/api/auth/logout')
    assert client.post('/api/auth/login',json={'username':'hf_tester','password':'my-new-password-123'}).status_code == 405
    with SessionLocal() as db:
        assert len(list(db.scalars(select(HuggingFaceIdentity)))) == 2


def test_hf_state_cookie_expiry_and_denial(client, monkeypatch):
    def should_not_exchange(*args):
        raise AssertionError('Unexpected provider request')
    monkeypatch.setattr(hf, 'fetch_profile', should_not_exchange)
    assert complete(client,'invalid').status_code == 400
    state = begin(client)
    with TestClient(app,headers={'X-Track-Request':'1'}) as other:
        assert complete(other,state).status_code == 400
    with SessionLocal() as db:
        attempt = db.get(OAuthAttempt,digest(state))
        attempt.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    assert complete(client,state).status_code == 400
    state=begin(client)
    response=client.get('/api/auth/huggingface/callback',params={'state':state,'error':'access_denied'})
    assert response.status_code == 400
    assert 'cancelled' in response.text
    assert client.get('/api/auth/me').json()['user']['username'] == 'tester'


def test_explicit_link_and_cross_account_conflict(client, monkeypatch):
    monkeypatch.setattr(hf,'fetch_profile',lambda *args:{'sub':'fixture-tester','preferred_username':'another-name'})
    original=client.get('/api/auth/me').json()['user']['id']
    assert complete(client,begin(client,link=True)).status_code == 303
    assert client.get('/api/auth/me').json()['user']['id'] == original
    client.post('/api/auth/logout')
    assert complete(client,begin(client)).status_code == 303
    assert client.get('/api/auth/me').json()['user']['id'] == original
    client.post('/api/auth/logout')
    sign_in(client, 'other')
    assert complete(client,begin(client,link=True)).status_code == 409
    assert client.get('/api/auth/me').json()['user']['username']=='other'
    state=begin(client,link=True)
    client.post('/api/auth/logout')
    assert complete(client,state).status_code == 400


def test_profile_failure_and_no_username_takeover(client, monkeypatch):
    client.post('/api/auth/logout')
    sign_in(client, 'hf_tester')
    existing=client.get('/api/auth/me').json()['user']['id']
    client.post('/api/auth/logout')
    monkeypatch.setattr(hf,'fetch_profile',lambda *args:{'sub':'new-sub','preferred_username':'tester'})
    assert complete(client,begin(client)).status_code == 303
    user=client.get('/api/auth/me').json()['user']
    assert user['id'] != existing
    assert user['username'].startswith('hf_tester_')
    with SessionLocal() as db:
        stored=db.get(AccountSession,digest(client.cookies.get(COOKIE)))
        stored.expires_at -= timedelta(minutes=6)
        db.commit()
    assert client.post('/api/auth/api-key',json={}).status_code == 401
    def fail(*args): raise ValueError('Bad provider response')
    monkeypatch.setattr(hf,'fetch_profile',fail)
    assert complete(client,begin(client)).status_code == 502


def test_pkce_exchange_and_userinfo_contract(client, monkeypatch):
    seen=[]
    class Provider:
        def __init__(self, **kw): pass
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def post(self,url,data):
            seen.append(data)
            assert url=='https://huggingface.co/oauth/token'
            assert data['client_id']==hf.client_id()
            assert data['code_verifier']=='verifier'
            return hf.httpx.Response(200,json={'access_token':'temporary-token'},request=hf.httpx.Request('POST',url))
        def get(self,url,headers):
            assert headers=={'Authorization':'Bearer temporary-token'}
            return hf.httpx.Response(200,json={'sub':'subject'},request=hf.httpx.Request('GET',url))
    monkeypatch.setattr(hf.httpx,'Client',Provider)
    assert hf.fetch_profile('code','verifier')['sub']=='subject'
    assert seen[0]['grant_type']=='authorization_code'
    metadata=hf.metadata()
    assert metadata['token_endpoint_auth_method']=='none'
    assert metadata['redirect_uris']==[hf.redirect_uri()]
