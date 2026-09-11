from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import sign_in
from fabryka_track.api import app
from fabryka_track.database import SessionLocal
from fabryka_track.goals import now
from fabryka_track.models import AgentGoal, GoalEvent, Run


def setup_goal(client):
    token = client.post('/api/goal-engine/connect', json={}).json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    response = client.post('/api/goals', json={'objective': 'Inspect the training pipeline and report a verified result.'})
    assert response.status_code == 201
    goal = response.json()
    claim = client.post('/api/goal-engine/claim', headers=headers, json={'runtime':'test-adapter'}).json()['goal']
    return goal, claim, headers


def report(client, goal, headers, **extra):
    body = {'lease': goal['lease'], 'event_id': 'event-1', 'message': 'Verified one task.', **extra}
    return client.post('/api/goal-engine/' + goal['id'] + '/progress', headers=headers, json=body)


def test_goal_lifecycle_private_tracking_and_idempotency(client):
    goal, claim, headers = setup_goal(client)
    assert client.post('/api/goals', json={'objective':'A second competing goal.'}).status_code == 409
    assert client.post('/api/goal-engine/claim', json={}, headers=headers).json()['goal'] is None
    assert report(client, claim, headers).status_code == 200
    assert report(client, claim, headers).status_code == 200
    with SessionLocal() as session:
        assert len(session.scalars(select(GoalEvent).where(GoalEvent.event_key=='event-1')).all()) == 1
        assert session.get(Run, goal['run_id']).is_public is False
    assert report(client, claim, headers, state='completed', event_id='done', message='All checks passed.').status_code == 200
    assert report(client, claim, headers, state='completed', event_id='done', message='All checks passed.').status_code == 200
    assert report(client, claim, headers, event_id='late').status_code == 409
    assert client.get('/api/goals').json()['active_id'] is None
    assert client.get('/api/runs/'+goal['run_id']).json()['state'] == 'finished'
    assert client.post('/api/goals', json={'objective':'A new goal after completion.'}).status_code == 201


def test_auth_isolation_and_scoped_worker_credential(client):
    goal, claim, headers = setup_goal(client)
    with TestClient(app) as stranger:
        assert stranger.get('/api/goals').status_code == 401
        assert stranger.get('/api/runs/'+goal['run_id']).status_code == 401
        assert stranger.get('/api/goals', headers=headers).status_code == 401
        sign_in(stranger, 'other-user')
        assert stranger.get('/api/goals/'+goal['id']).status_code == 404
        other_token=stranger.post('/api/goal-engine/connect',json={},headers={'X-Track-Request':'1'}).json()['token']
        assert report(stranger,claim,{'Authorization':'Bearer '+other_token}).status_code == 409
    assert client.post('/api/goals', json={'objective':'csrf missing'}, headers={'X-Track-Request':'0'}).status_code == 403


def test_stop_wins_over_completion_and_releases_slot_only_after_ack(client):
    goal, claim, headers = setup_goal(client)
    assert client.post('/api/goal-engine/connect', json={}).status_code == 409
    result=client.post('/api/goals/'+goal['id']+'/control',json={'action':'stop'})
    assert result.json()['state']=='stopping'
    assert client.post('/api/goals',json={'objective':'Cannot overlap this work.'}).status_code==409
    assert report(client,claim,headers,message='',event_id='heartbeat').json()['stop'] is True
    assert report(client,claim,headers,state='completed',message='I finished',event_id='finish').json()['state']=='cancelled'
    assert client.get('/api/goals').json()['active_id'] is None


def test_block_resume_fences_old_worker_and_includes_user_context(client):
    goal, claim, headers = setup_goal(client)
    assert report(client,claim,headers,state='blocked',message='Need a data location.').status_code==200
    assert client.post('/api/goals',json={'objective':'Cannot skip a blocked goal.'}).status_code==409
    assert client.post('/api/goals/'+goal['id']+'/control',json={'action':'resume','message':'Use /data/corpus.'}).json()['state']=='queued'
    new=client.post('/api/goal-engine/claim',json={},headers=headers).json()['goal']
    assert new['lease']!=claim['lease']
    assert any('/data/corpus' in s for s in new['context'])
    assert report(client,claim,headers,event_id='stale').status_code==409


def test_lease_expiry_blocks_without_automatic_reexecution(client):
    goal, claim, headers = setup_goal(client)
    with SessionLocal() as session:
        session.get(AgentGoal,goal['id']).lease_until=now()-timedelta(seconds=1)
        session.commit()
    assert report(client,claim,headers).status_code==409
    assert client.get('/api/goals/'+goal['id']).json()['goal']['state']=='blocked'
    assert client.post('/api/goal-engine/claim',json={},headers=headers).json()['goal'] is None


def test_concurrent_claims_have_one_winner(client):
    token=client.post('/api/goal-engine/connect',json={}).json()['token']
    headers={'Authorization':'Bearer '+token}
    client.post('/api/goals',json={'objective':'Claim this goal exactly once.'})
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:client.post('/api/goal-engine/claim',json={},headers=headers),range(4)))
    assert all(r.status_code==200 for r in results)
    assert sum(r.json()['goal'] is not None for r in results)==1


def test_concurrent_creates_have_one_active_goal(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:client.post('/api/goals',json={'objective':'Create just one active goal.'}),range(4)))
    assert sorted(r.status_code for r in results)==[201,409,409,409]


def test_goals_pages_and_asset(client):
    r=client.get('/goal', follow_redirects=False)
    assert r.status_code==307
    assert r.headers['location']=='https://github.com/slayerlabs/rfcs/pull/5'
    r=client.get('/status')
    assert r.status_code==200 and '<html lang="en">' in r.text
    assert '/assets/goals.js' in r.text
    assert client.get('/assets/goals.js').status_code==200
