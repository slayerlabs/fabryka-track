from uuid import uuid4
from fastapi.testclient import TestClient
from fabryka_track.api import app
from fabryka_track.accounts import _attempts


def register(client,name='Agent A'):
    r=client.post('/api/agents/register',json={'name':name});assert r.status_code==201,r.text
    return r.json()


def test_open_registration_and_independent_research(client):
    with TestClient(app,headers={'X-Track-Request':'1'}) as anon:
        a=register(anon);b=register(anon,'Agent B')
        assert a['account']['id']!=b['account']['id']
        h={'Authorization':'Bearer '+a['api_key']}
        assert anon.get('/api/agents/me',headers=h).json()['agent']['name']=='Agent A'
        assert anon.get('/api/auth/me',headers=h).json()['user']['id']==a['account']['id']
        payload={'event_id':str(uuid4()),'stage':'readiness','kind':'finding','body':'Checked a fixture.','evidence':[]}
        r=anon.post('/api/research/rfc-005/notes',json=payload,headers=h)
        assert r.status_code==200 and r.json()['author']=={'id':a['agent']['id'],'name':'Agent A'}
        assert anon.get('/api/research/rfc-005/notes',headers={'Authorization':'Bearer '+b['api_key']}).json()['notes']==[]
        assert client.get('/api/research/rfc-005/notes').json()['notes']==[]
        assert 'Agent A' in anon.get('/api/research/rfc-005/scratchpad.md',headers=h).text
        assert anon.get('/api/research/rfc-005/notes').status_code==401
        assert 'api_key' not in anon.get('/api/agents/me',headers=h).json()['agent']


def test_rotation_and_revocation(client):
    a=register(client);h={'Authorization':'Bearer '+a['api_key']}
    r=client.post('/api/agents/me/api-key',headers=h);assert r.status_code==200
    assert client.get('/api/agents/me',headers=h).status_code==401
    h={'Authorization':'Bearer '+r.json()['api_key']}
    assert client.get('/api/agents/me',headers=h).status_code==200
    assert client.delete('/api/agents/me/api-key',headers=h).status_code==200
    assert client.get('/api/research/rfc-005/notes',headers=h).status_code==401


def test_registration_validation_rate_limit_and_pages(client):
    assert client.post('/api/agents/register',json={'name':'  '}).status_code==422
    assert client.post('/api/agents/register',json={'name':'Agent'},headers={'X-Track-Request':'0'}).status_code==403
    _attempts.clear()
    for _ in range(30):assert client.post('/api/agents/register',json={'name':'  '}).status_code==422
    assert client.post('/api/agents/register',json={'name':'Agent'}).status_code==429
