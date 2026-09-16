from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from sqlalchemy import select
from fabryka_track.api import app
from fabryka_track.models import Account
from fabryka_track.database import SessionLocal
from fabryka_track.accounts import digest
from conftest import sign_in

URL='/api/research/rfc-005/notes'
def note(**kwargs):
    return dict(event_id=str(uuid4()),stage='readiness',kind='finding',body='Agent A: verified the fixture. Next: check resume.',evidence=['https://example.com/evidence'],**kwargs)


def test_persistent_history_and_retry_conflict(client):
    body=note();r=client.post(URL,json=body);assert r.status_code==200
    assert client.post(URL,json=body).json()['id']==r.json()['id']
    assert client.post(URL,json={**body,'body':'Changed result'}).status_code==409
    assert len(client.get(URL).json()['notes'])==1
    text=client.get('/api/research/rfc-005/scratchpad.md').text
    assert body['body'] in text and body['evidence'][0] in text
    assert client.post(URL,json={**note(),'body':'   '}).status_code==422
    assert client.post(URL,json={**note(),'evidence':['javascript:alert(1)']}).status_code==422


def test_isolation_and_agent_auth(client):
    client.post(URL,json=note())
    with TestClient(app) as other:
        assert other.get(URL).status_code==401
        assert other.get('/api/research/rfc-005/scratchpad.md').status_code==401
        sign_in(other,'another-user');assert other.get(URL).json()['notes']==[]
    with SessionLocal() as s:
        user=s.scalar(select(Account).where(Account.username=='tester'));user.api_key_hash=digest('agent-fixture');s.commit()
    with TestClient(app) as agent:
        assert agent.get(URL,headers={'Authorization':'Bearer agent-fixture'}).json()['notes']
        assert agent.post(URL,json=note(),headers={'Authorization':'Bearer agent-fixture'}).status_code==200
    assert client.post(URL,json=note(),headers={'X-Track-Request':'0'}).status_code==403


def test_concurrent_agents_append_without_overwriting(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses=list(pool.map(lambda _:client.post(URL,json=note()),range(4)))
    assert all(r.status_code==200 for r in responses)
    assert len(client.get(URL).json()['notes'])==4


def test_pagination(client):
    for _ in range(51):assert client.post(URL,json=note()).status_code==200
    first=client.get(URL).json();assert len(first['notes'])==50
    last=client.get(URL,params={'before':first['next_before']}).json();assert len(last['notes'])==1
