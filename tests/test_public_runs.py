from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from fabryka_track.api import app
from fabryka_track.database import SessionLocal, create_tables
from fabryka_track.models import Account, Project, Run


@pytest.mark.parametrize('state', ['queued', 'running', 'stopping', 'finished', 'failed', 'cancelled', 'interrupted', 'paused'])
def test_every_public_state_is_readable_without_owner_access(client, state):
    with SessionLocal() as db:
        project = Project(name='Public test')
        db.add(project)
        db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, owner_id=db.scalar(select(Account.id)),
                  name='Shared run', state=state, config={'secret': 'hidden'}, note='private note')
        db.add(run)
        db.commit()
        rid = run.id
    with TestClient(app, headers={'X-Track-Request': '1'}) as anonymous:
        response = anonymous.get('/api/runs/' + rid)
        assert response.status_code == 200
        assert response.json()['read_only'] is True
        assert 'hidden' not in response.text and 'private note' not in response.text
        listing = anonymous.get('/api/public/runs').json()
        assert [item['id'] for item in listing] == [rid]
        assert anonymous.patch('/api/runs/' + rid + '/notes', json={'note': 'changed', 'conclusion': ''}).status_code == 401
        with SessionLocal() as db:
            db.get(Run, rid).is_public = False
            db.commit()
        assert anonymous.get('/api/runs/' + rid).status_code == 401
        assert anonymous.get('/api/public/runs').json() == []


def test_existing_runs_are_published_once(client):
    with SessionLocal() as db:
        project = Project(name='Legacy public test')
        db.add(project)
        db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, name='Legacy', is_public=False)
        db.add(run)
        db.execute(text("DELETE FROM track_migrations WHERE name='all-runs-public-v2'"))
        db.commit()
        rid = run.id
    create_tables()
    with SessionLocal() as db:
        assert db.get(Run, rid).is_public is True
        db.get(Run, rid).is_public = False
        db.commit()
    create_tables()
    with SessionLocal() as db:
        assert db.get(Run, rid).is_public is False
