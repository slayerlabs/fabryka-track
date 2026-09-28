from conftest import sign_in
from test_api import event
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from fabryka_track.api import app
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Metric, Project, Run

SHA = 'a' * 64
EN = {'board/eff': 41.5, 'board/arc_easy': 38.2, 'board/blimp': 71.0, 'board/wiki_byte_ppl': 2.91}
T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def trusted_board(monkeypatch):
    """The deployment trusts the fixture account and one evaluation-harness revision. "Mallory" is listed
    only to show that a different-case account name ("mallory") is not trusted."""
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_trusted_owners', 'tester, Mallory')
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_harness_shas', '2c5ea968d7')


def result(**overrides):
    value = {'step': 1000, 'checkpoint_sha256': SHA, 'n_params': 16_000_000, 'tokens_seen': 320_000_000,
             'harness_sha': '2c5ea968', 'scale_rev': 'Glint 2c5ea968 (2026-09-28)',
             'label': 'final checkpoint (result)', 'kind': 'track', 'trust': 'verified'}
    value.update(overrides)
    return {k: v for k, v in value.items() if v is not None}


def external(**overrides):
    return result(**{'kind': 'external', 'trust': 'measured', 'harness_sha': None, 'model_name': 'Tiny Llama 20M',
                     'author': 'Jane Doe', 'hf_repo': 'org-name/tiny.llama_20M', 'revision': '0123abcd', **overrides})


def make_run(name, points, state='finished', public=True, ended=T0, owner='tester'):
    """points: {step: {metric key: value}}"""
    with SessionLocal() as db:
        project = db.scalar(select(Project).where(Project.name == 'Model board')) or Project(name='Model board')
        db.add(project)
        db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, owner_id=db.scalar(select(Account.id).where(Account.username == owner)),
                  name=name, state=state, is_public=public, metadata_={'engine': 'sdk'},
                  config={'secret': 'hidden-config'}, note='private owner note', started_at=ended - timedelta(hours=2),
                  ended_at=ended if state == 'finished' else None)
        db.add(run)
        db.flush()
        for step, values in points.items():
            for key, value in values.items():
                db.add(Metric(run_id=run.id, key=key, step=step, value=value))
        db.commit()
        return run.id


def publish(client, rid, value, board=True):
    assert client.put(f'/api/runs/{rid}/attributes/visibility/public_board_metrics', json={'value': board}).status_code == 200
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard/result', json={'value': value}).status_code == 200


def board():
    with TestClient(app) as anonymous:
        response = anonymous.get('/api/leaderboard/models')
    assert response.status_code == 200
    return response


def test_board_lists_only_finished_public_opted_in_results_with_values_at_the_marked_step(client):
    later = {k: v + 10 for k, v in EN.items()}
    good = make_run('good', {500: {'board/eff': 1.0}, 1000: {**EN, 'board_pl/multiblimp': 62.5, 'private/diagnostic': 9.},
                             1500: {**later, 'board_pl/multiblimp': 70.0}})
    publish(client, good, result())
    assert client.put(f'/api/runs/{good}/attributes/visibility/public_note', json={'value': 'Glint ranges pinned.'}).status_code == 200
    assert client.put(f'/api/runs/{good}/attributes/private/secret', json={'value': 'owner-only attribute'}).status_code == 200
    excluded = {'running': make_run('running', {1000: EN}, state='running'),
                'private': make_run('private', {1000: EN}, public=False),
                'failed': make_run('failed', {1000: EN}, state='failed')}
    for rid in excluded.values():
        publish(client, rid, result(checkpoint_sha256='b' * 64))
    not_opted = make_run('not opted in', {1000: EN})
    publish(client, not_opted, result(checkpoint_sha256='c' * 64), board='yes')
    no_result = make_run('no result', {1000: EN})
    assert client.put(f'/api/runs/{no_result}/attributes/visibility/public_board_metrics', json={'value': True}).status_code == 200
    wrong_step = make_run('wrong step', {999: EN})
    publish(client, wrong_step, result(checkpoint_sha256='d' * 64))
    pl_only = make_run('pl only', {1000: {'board/eff': 30.0, 'board/arc_easy': 30.0, 'board/blimp': 60.0,
                                          'board_pl/multiblimp': 55.0, 'board_pl/eff': 12.0}})
    publish(client, pl_only, result(checkpoint_sha256='e' * 64))
    en_only = make_run('en only', {1000: EN, 1001: {'board_pl/multiblimp': 80.0}})
    publish(client, en_only, result(checkpoint_sha256='f' * 64, trust=None, harness_sha=None))

    response = board()
    rows = {row['name']: row for row in response.json()['models']}
    assert set(rows) == {'good', 'pl only', 'en only'}
    row = rows['good']
    assert row['en'] == {'eff': 41.5, 'arc_easy': 38.2, 'blimp': 71.0, 'wiki_byte_ppl': 2.91}
    assert row['pl'] == {'multiblimp': 62.5, 'eff': None}
    assert row['categories'] == ['en', 'pl']
    assert (row['kind'], row['trust'], row['owner'], row['step']) == ('track', 'verified', 'tester', 1000)
    assert row['public_note'] == 'Glint ranges pinned.' and row['hf_url'] is None and row['author'] is None
    # Missing values stay null (never 0) and the incomplete category is dropped.
    assert rows['pl only']['en']['wiki_byte_ppl'] is None and rows['pl only']['en']['eff'] == 30.0
    assert rows['pl only']['categories'] == ['pl'] and rows['pl only']['pl']['eff'] == 12.0
    assert rows['en only']['categories'] == ['en'] and rows['en only']['pl']['multiblimp'] is None
    assert rows['en only']['trust'] == 'measured' and rows['en only']['public_note'] is None
    for private in ('private owner note', 'hidden-config', 'owner-only attribute', 'private/diagnostic'):
        assert private not in response.text
    # Withdrawing the opt-in or the marker removes the row.
    assert client.put(f'/api/runs/{pl_only}/attributes/visibility/public_board_metrics', json={'value': False}).status_code == 200
    assert client.put(f'/api/runs/{en_only}/attributes/leaderboard/result', json={'value': None}).status_code == 200
    assert {row['name'] for row in board().json()['models']} == {'good'}


def test_board_keeps_the_earliest_trusted_row_per_checkpoint_and_links_external_models_to_the_pinned_revision(client):
    original = make_run('original', {1000: EN}, ended=T0)
    sign_in(client, 'mallory')
    copy = make_run('copied sha', {1000: {k: v + 20 for k, v in EN.items()}}, ended=T0 + timedelta(days=1), owner='mallory')
    publish(client, copy, result())
    only_untrusted = [make_run(f'untrusted {day}', {1000: EN}, ended=T0 + timedelta(days=day), owner='mallory')
                      for day in (3, 2)]
    for rid in only_untrusted:
        publish(client, rid, result(checkpoint_sha256='2' * 64))
    sign_in(client)
    later_own = make_run('later own copy', {1000: EN}, ended=T0 + timedelta(days=2))
    for rid in (later_own, original):
        publish(client, rid, result())
    measured = make_run('measurement run', {1000: {'board_pl/multiblimp': 58.0}})
    publish(client, measured, external(checkpoint_sha256='1' * 64))
    rows = board().json()['models']
    # A newer run that copies a checkpoint sha cannot replace the trusted original, even when it is newer.
    assert [row['run_id'] for row in rows if row['checkpoint_sha256'] == SHA] == [original]
    # Among untrusted claims of one sha the earliest wins.
    assert [row['run_id'] for row in rows if row['checkpoint_sha256'] == '2' * 64] == [only_untrusted[1]]
    ext = next(row for row in rows if row['kind'] == 'external')
    assert ext['name'] == 'Tiny Llama 20M' and ext['author'] == 'Jane Doe' and ext['trust'] == 'measured'
    assert ext['hf_url'] == 'https://huggingface.co/org-name/tiny.llama_20M/tree/0123abcd'
    assert ext['categories'] == ['pl']


def test_trust_badges_are_granted_by_the_server_not_declared_by_the_owner(client):
    sign_in(client, 'mallory')
    claims = {'mallory verified': result(checkpoint_sha256='3' * 64),
              'mallory measured': external(checkpoint_sha256='4' * 64, model_name='mallory measured')}
    for name, value in claims.items():
        publish(client, make_run(name, {1000: {**EN, 'board_pl/multiblimp': 60.0}}, owner='mallory'), value)
    sign_in(client)
    own = {'known harness': result(checkpoint_sha256='5' * 64),
           'unknown harness': result(checkpoint_sha256='6' * 64, harness_sha='deadbeef'),
           'declared reported': result(checkpoint_sha256='7' * 64, trust='reported', harness='own eval script')}
    for name, value in own.items():
        publish(client, make_run(name, {1000: EN}), value)
    trust = {row['name']: row['trust'] for row in board().json()['models']}
    assert trust == {'mallory verified': 'reported', 'mallory measured': 'reported', 'known harness': 'verified',
                     'unknown harness': 'measured', 'declared reported': 'reported'}


@pytest.mark.parametrize('value', [
    result(checkpoint_sha256='A' * 64),
    result(checkpoint_sha256='a' * 63),
    result(checkpoint_sha256=None),
    result(step=-1),
    result(step=1000.0),
    result(step=True),
    result(n_params=0),
    result(label='best checkpoint'),
    result(url='https://example.com/model'),
    result(trust='verified', harness_sha=None),
    result(trust='reported'),
    result(trust='gold'),
    result(kind='fork'),
    result(harness='<b>Glint</b>'),
    result(scale_rev='Glint\u202e2c5ea968'),
    result(scale_rev='x' * 41),
    result(author='Jane Doe'),
    external(trust='verified', harness_sha='2c5ea968'),
    external(trust=None),
    external(trust='reported'),
    external(hf_repo='https://evil.example/org/model'),
    external(hf_repo='../..'),
    external(revision='main'),
    external(model_name='<img src=x onerror=alert(1)>'),
    external(author=None),
    external(link='https://evil.example'),
    {},
    'final checkpoint (result)',
])
def test_result_marker_is_rejected_on_every_write_path(client, value):
    rid = make_run('validated', {1000: EN})
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard/result', json={'value': value}).status_code == 422
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard', json={'value': {'result': value}}).status_code == 422
    attr = event('run.attribute', {'run_id': rid, 'path': 'leaderboard/result', 'value': value})
    assert client.post('/api/events', json={'events': [attr]}).status_code == 422
    assert client.get(f'/api/runs/{rid}/attributes/leaderboard/result').status_code == 404


def test_result_marker_accepts_complete_objects_only_from_the_owner(client):
    rid = make_run('accepted', {1000: EN})
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard', json={'value': {'result': result()}}).status_code == 200
    stored = client.get(f'/api/runs/{rid}/attributes/leaderboard/result').json()['value']
    assert stored == result()
    # Fields cannot be edited one by one, not even with a valid value.
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard/result/step', json={'value': 2000}).status_code == 422
    assert client.put(f'/api/runs/{rid}/attributes/leaderboard', json={'value': {'result/step': -5}}).status_code == 422
    reported = external(trust='reported', harness='lm-eval-harness 0.4.2, 5-shot')
    attr = event('run.attribute', {'run_id': rid, 'path': 'leaderboard/result', 'value': reported})
    assert client.post('/api/events', json={'events': [attr]}).status_code == 200
    with TestClient(app, headers={'X-Track-Request': '1'}) as stranger:
        sign_in(stranger, 'board-stranger')
        assert stranger.put(f'/api/runs/{rid}/attributes/leaderboard/result', json={'value': result()}).status_code in (403, 404)
