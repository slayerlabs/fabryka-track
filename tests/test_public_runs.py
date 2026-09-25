from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from fabryka_track.api import app
from fabryka_track.database import SessionLocal, create_tables
from fabryka_track.models import Account, Project, Run


def test_missing_and_deleted_runs_do_not_prompt_anonymous_visitors_to_sign_in(client):
    rid = str(uuid4())
    path = '/api/runs/' + rid
    with TestClient(app) as anonymous:
        for viewer in (client, anonymous):
            response = viewer.get(path)
            assert response.status_code == 404
            assert response.json()['detail'] == 'Run not found. It may have been deleted or the link is incorrect.'
        with SessionLocal() as db:
            project = Project(name='Deleted public run')
            db.add(project)
            db.flush()
            db.add(Run(id=rid, project_id=project.id, owner_id=db.scalar(select(Account.id)),
                       name='Shared run', state='finished'))
            db.commit()
        assert anonymous.get(path).status_code == 200
        assert client.delete(path).status_code == 200
        assert anonymous.get(path).status_code == 404


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


def test_sdk_gradients_are_public_but_unrelated_metrics_stay_private(client):
    from fabryka_track.models import Metric
    with SessionLocal() as db:
        project = Project(name='Gradient visibility')
        db.add(project)
        db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, owner_id=db.scalar(select(Account.id)),
                  name='SDK gradients', state='running', metadata_={'engine': 'sdk'})
        db.add(run)
        db.flush()
        for key, value in {'optimizer/gradient_norm': 2.5, 'optimizer/gradient_clip_threshold': 1.,
                           'optimizer/gradient_clipped': 1., 'private/diagnostic': 42.}.items():
            db.add(Metric(run_id=run.id, key=key, step=10, value=value))
        db.commit()
        rid = run.id
    with TestClient(app) as anonymous:
        metrics = anonymous.get('/api/runs/' + rid).json()['metrics']
        assert metrics['optimizer/gradient_norm'][0]['value'] == 2.5
        assert metrics['optimizer/gradient_clipped'][0]['value'] == 1.
        assert 'private/diagnostic' not in metrics
