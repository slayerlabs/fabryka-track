from conftest import sign_in
from test_api import event
import math
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from fabryka_track.api import app
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, BenchmarkEvaluation, Metric, Project, Run
from fabryka_track.tiny_ml_suite import PROTOCOL as TINY_ML_PROTOCOL, TASKS as TINY_ML_TASKS

SHA = 'a' * 64
EN = {'board/eff': 41.5, 'board/arc_easy': 38.2, 'board/blimp': 71.0, 'board/wiki_byte_ppl': 2.91}
T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def trusted_board(monkeypatch):
    """The deployment trusts the fixture account and one evaluation-harness revision. "Mallory" is listed
    only to show that a different-case account name ("mallory") is not trusted."""
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_trusted_owners', 'tester, Mallory')
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_harness_shas', '2c5ea968d7')
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_publish_tiny_ml', False)


def result(**overrides):
    value = {'step': 1000, 'checkpoint_sha256': SHA, 'n_params': 16_000_000, 'tokens_seen': 320_000_000,
             'harness_sha': '2c5ea968', 'scale_rev': 'Glint 2c5ea968 (2026-09-28)',
             'label': 'final checkpoint (result)', 'kind': 'track', 'trust': 'verified'}
    value.update(overrides)
    return {k: v for k, v in value.items() if v is not None}


def external(**overrides):
    return result(**{'kind': 'external', 'trust': 'measured', 'harness_sha': None, 'model_name': 'Tiny Llama 20M',
                     'author': 'Jane Doe', 'hf_repo': 'org-name/tiny.llama_20M', 'revision': '0123abcd', **overrides})


def make_run(name, points, state='finished', public=True, ended=T0, owner='tester', config=None, engine='sdk'):
    """points: {step: {metric key: value}}"""
    with SessionLocal() as db:
        project = db.scalar(select(Project).where(Project.name == 'Model board')) or Project(name='Model board')
        db.add(project)
        db.flush()
        run = Run(id=str(uuid4()), project_id=project.id, owner_id=db.scalar(select(Account.id).where(Account.username == owner)),
                  name=name, state=state, is_public=public, metadata_={'engine': engine},
                  config=config or {'hidden': 'hidden-config'}, note='private owner note', started_at=ended - timedelta(hours=2),
                  ended_at=ended if state == 'finished' else None)
        db.add(run)
        db.flush()
        for step, values in points.items():
            for key, value in values.items():
                db.add(Metric(run_id=run.id, key=key, step=step, value=value))
        db.commit()
        return run.id


def tiny_ml_results(blimp=.7, arc=.4, wiki=1.86):
    """At wiki byte-PPL 1.86 the wiki score is 100, so eff = (100·blimp + 100·arc + 100) / 3 × size multiplier."""
    return {'blimp': {'accuracy': blimp}, 'arc_easy': {'accuracy': arc}, 'wikitext': {'byte_perplexity': wiki},
            'aci': {'aci_score': 62.5, 'samples': 5000}}


def evaluate(rid, results, ended, tasks=TINY_ML_TASKS, sha=SHA, status='finished', mode='full', **provenance):
    """A server evaluation row as the benchmark queue stores it; Tiny-ML ones are marked private like start() does.
    `parameters_counted` is what the evaluation worker counted from the checkpoint; pass None to omit it."""
    if tasks is TINY_ML_TASKS:
        provenance = {'protocol': TINY_ML_PROTOCOL, 'visibility': 'private', **provenance}
    provenance = {'checkpoint_sha256': sha, 'parameters_counted': 1000, **provenance}
    with SessionLocal() as db:
        db.add(BenchmarkEvaluation(run_id=rid, status=status, mode=mode, tasks=list(tasks), results=results,
                                   provenance={k: v for k, v in provenance.items() if v is not None},
                                   created_at=ended - timedelta(minutes=30), ended_at=ended))
        db.commit()


def polish(rid, accuracy, ended, **provenance):
    evaluate(rid, {'multiblimp_polish': {'accuracy': accuracy, 'samples': 200}}, ended,
             tasks=['multiblimp_polish'], **{'protocol': 'tinylm-en-v1-byte-sliding', **provenance})


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
    assert client.put(f'/api/runs/{good}/attributes/private/owner_only', json={'value': 'owner-only attribute'}).status_code == 200
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
    assert row['pl'] == {'multiblimp': 62.5, 'arc_easy': None, 'byte_ppl': None, 'eff': None}
    assert row['combined'] is None
    assert row['categories'] == ['en', 'pl']
    assert (row['kind'], row['trust'], row['owner'], row['step']) == ('track', 'verified', 'tester', 1000)
    assert row['public_note'] == 'Glint ranges pinned.' and row['hf_url'] is None and row['author'] is None
    # Missing values stay null (never 0) and the incomplete category is dropped.
    assert rows['pl only']['en']['wiki_byte_ppl'] is None and rows['pl only']['en']['eff'] == 30.0
    assert rows['pl only']['categories'] == ['pl'] and rows['pl only']['pl']['eff'] == 12.0
    assert rows['pl only']['combined'] is None
    assert rows['en only']['categories'] == ['en'] and rows['en only']['pl']['multiblimp'] is None
    assert rows['en only']['trust'] == 'measured' and rows['en only']['public_note'] is None
    for private in ('private owner note', 'hidden-config', 'owner-only attribute', 'private/diagnostic'):
        assert private not in response.text
    # Withdrawing the opt-in or the marker removes the row.
    assert client.put(f'/api/runs/{pl_only}/attributes/visibility/public_board_metrics', json={'value': False}).status_code == 200
    assert client.put(f'/api/runs/{en_only}/attributes/leaderboard/result', json={'value': None}).status_code == 200
    assert {row['name'] for row in board().json()['models']} == {'good'}


def test_combined_pl_en_is_the_mean_of_both_effs_and_only_rows_with_both_join_plen(client):
    pl = {'board_pl/multiblimp': 60.0, 'board_pl/arc_easy': 35.0, 'board_pl/byte_ppl': 3.1234}
    cases = {'both': {**EN, **pl, 'board_pl/eff': 20.5}, 'en eff only': {**EN, **pl},
             'pl eff only': {**pl, 'board_pl/eff': 20.5}, 'neither': pl,
             'non-finite': {**EN, **pl, 'board_pl/eff': float('inf')},
             'incomplete en': {**{k: v for k, v in EN.items() if k != 'board/wiki_byte_ppl'}, **pl, 'board_pl/eff': 20.5}}
    for index, (name, values) in enumerate(cases.items()):
        publish(client, make_run(name, {1000: values}), result(checkpoint_sha256=str(index) * 64))
    rows = {row['name']: row for row in board().json()['models']}
    assert rows['both']['combined'] == pytest.approx((41.5 + 20.5) / 2)
    assert rows['both']['categories'] == ['en', 'pl', 'plen']
    assert rows['both']['pl'] == {'multiblimp': 60.0, 'arc_easy': 35.0, 'byte_ppl': 3.1234, 'eff': 20.5}
    for name in ('en eff only', 'pl eff only', 'neither', 'non-finite', 'incomplete en'):
        assert rows[name]['combined'] is None and 'plen' not in rows[name]['categories']
    assert rows['non-finite']['pl']['eff'] is None


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
           'declared reported': result(checkpoint_sha256='7' * 64, trust='reported', harness='own eval script'),
           # A trusted owner's external model it measured itself: "measured by Fabryka", never self-reported.
           'own external measured': external(checkpoint_sha256='8' * 64, model_name='own external measured')}
    for name, value in own.items():
        publish(client, make_run(name, {1000: EN}), value)
    trust = {row['name']: row['trust'] for row in board().json()['models']}
    assert trust == {'mallory verified': 'reported', 'mallory measured': 'reported', 'known harness': 'verified',
                     'unknown harness': 'measured', 'declared reported': 'reported', 'own external measured': 'measured'}


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
    # "measured by track" is granted only to the server's own evaluations, never claimed by an owner.
    result(trust='track'),
    external(trust='track', harness='own eval script'),
    result(kind='fork'),
    result(harness='<b>Glint</b>'),
    result(scale_rev='Glint\u202e2c5ea968'),
    result(scale_rev='x' * 41),
    result(author='<b>Jane Doe</b>'),
    result(author='x' * 81),
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


def test_a_track_result_may_name_its_author_and_otherwise_leaves_it_to_the_owner_account(client):
    named = make_run('named', {1000: EN})
    publish(client, named, result(author='Jane Doe & Team'))
    assert client.get(f'/api/runs/{named}/attributes/leaderboard/result').json()['value']['author'] == 'Jane Doe & Team'
    unnamed = make_run('unnamed', {1000: EN})
    publish(client, unnamed, result(checkpoint_sha256='9' * 64))
    rows = {row['name']: row for row in board().json()['models']}
    assert (rows['named']['author'], rows['named']['owner']) == ('Jane Doe & Team', 'tester')
    assert (rows['unnamed']['author'], rows['unnamed']['owner']) == (None, 'tester')


def test_every_public_finished_run_gets_a_row_from_its_latest_complete_track_evaluation(client, monkeypatch):
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_publish_tiny_ml', True)
    measured = make_run('measured', {}, config={'parameters': 999_999})
    # The better but older evaluation loses to the latest complete one ("last measured", never "best").
    evaluate(measured, tiny_ml_results(blimp=.9, arc=.6), T0 + timedelta(days=1), sha='1' * 64)
    evaluate(measured, tiny_ml_results(), T0 + timedelta(days=2), checkpoint_step=4000, training_tokens=8_000_000)
    polish(measured, .72, T0 + timedelta(days=2, hours=1))
    # Never a smoke, failed or incomplete run of the suite, nor a private evaluation of another suite.
    evaluate(measured, tiny_ml_results(blimp=.99), T0 + timedelta(days=3), mode='smoke')
    evaluate(measured, tiny_ml_results(blimp=.99), T0 + timedelta(days=3), status='failed')
    evaluate(measured, {**tiny_ml_results(blimp=.99), 'aci': {'error': 'worker stopped'}}, T0 + timedelta(days=3))
    polish(measured, .99, T0 + timedelta(days=3), visibility='private')
    for name, options in {'private run': {'public': False}, 'running run': {'state': 'running'},
                          'failed run': {'state': 'failed'}, 'reference': {'engine': 'benchmark-reference'}}.items():
        evaluate(make_run(name, {}, **options), tiny_ml_results(), T0, sha='2' * 64)
    # A later Polish evaluation of another checkpoint becomes the row; the Tiny-ML numbers of the old one are dropped.
    moved = make_run('moved on', {})
    evaluate(moved, tiny_ml_results(), T0, sha='3' * 64)
    polish(moved, .6, T0 + timedelta(days=1), sha='4' * 64, protocol='track-leaderboard-pl-v1', parameters_counted=20_000_000)

    response = board()
    rows = {row['name']: row for row in response.json()['models']}
    assert set(rows) == {'measured', 'moved on'}
    row = rows['measured']
    assert (row['kind'], row['trust'], row['label']) == ('track', 'track', 'latest server evaluation')
    assert (row['checkpoint_sha256'], row['step'], row['tokens_seen'], row['n_params']) == (SHA, 4000, 8_000_000, 1000)
    # eff = (70 + 40 + 100) / 3 × 1.5 at 1000 parameters; accuracies on the board's 0–100 scale.
    assert row['en'] == pytest.approx({'eff': 105.0, 'arc_easy': 40.0, 'blimp': 70.0, 'wiki_byte_ppl': 1.86})
    assert row['pl'] == pytest.approx({'multiblimp': 72.0, 'arc_easy': None, 'byte_ppl': None, 'eff': None})
    assert row['categories'] == ['en', 'pl']
    assert row['scale_rev'] == 'tiny_ml 3fce6037 (1000–150M)'
    assert row['harness'] == f'{TINY_ML_PROTOCOL} + tinylm-en-v1-byte-sliding'
    assert row['public_note'] is None and row['evaluated_at'].startswith('2026-09-03')
    other = rows['moved on']
    assert other['checkpoint_sha256'] == '4' * 64 and other['categories'] == ['pl']
    assert other['en']['eff'] is None and other['pl']['multiblimp'] == pytest.approx(60.0)
    assert other['n_params'] == 20_000_000 and other['step'] is None and other['scale_rev'] is None
    assert 'hidden-config' not in response.text and 'private owner note' not in response.text


def test_tiny_ml_aggregates_reach_the_public_board_only_when_the_deployment_publishes_them(client, monkeypatch):
    only_tiny_ml = make_run('tiny-ml only', {})
    evaluate(only_tiny_ml, tiny_ml_results(), T0, sha='5' * 64)
    both = make_run('both suites', {})
    evaluate(both, tiny_ml_results(), T0, sha='6' * 64, parameters_counted=8_000_000)
    polish(both, .55, T0, sha='6' * 64, parameters_counted=8_000_000)
    rows = {row['name']: row for row in board().json()['models']}
    assert set(rows) == {'both suites'}
    assert rows['both suites']['categories'] == ['pl'] and set(rows['both suites']['en'].values()) == {None}
    assert rows['both suites']['n_params'] == 8_000_000

    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_publish_tiny_ml', True)
    rows = {row['name']: row for row in board().json()['models']}
    assert set(rows) == {'tiny-ml only', 'both suites'}
    assert rows['both suites']['categories'] == ['en', 'pl'] and rows['tiny-ml only']['categories'] == ['en']


def test_track_rows_use_the_parameter_count_measured_from_the_checkpoint_never_the_declared_one(client, monkeypatch):
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_publish_tiny_ml', True)
    # The owner declares 1M parameters (run config and the evaluation's copied `parameters`); the checkpoint holds 100M.
    understated = make_run('understated', {}, config={'parameters': 1_000_000})
    evaluate(understated, tiny_ml_results(), T0, sha='5' * 64, parameters=1_000_000, parameters_counted=100_000_000)
    # Evaluations recorded before the server counted parameters do not qualify, in either category.
    uncounted = make_run('uncounted', {}, config={'parameters': 8_000_000})
    evaluate(uncounted, tiny_ml_results(), T0, sha='6' * 64, parameters=8_000_000, parameters_counted=None)
    polish(uncounted, .7, T0, sha='6' * 64, parameters_counted=None)
    rows = {row['name']: row for row in board().json()['models']}
    assert set(rows) == {'understated'}
    row = rows['understated']
    bonus = 1 + .5 * math.log(150e6 / 100e6) / math.log(150e6 / 1000)
    assert row['n_params'] == 100_000_000
    assert row['en']['eff'] == pytest.approx(70 * bonus)


def test_an_owner_marked_result_takes_precedence_over_the_track_measurement(client, monkeypatch):
    monkeypatch.setattr('fabryka_track.model_board.settings.model_board_publish_tiny_ml', True)
    marked = make_run('marked', {1000: EN})
    publish(client, marked, result())
    evaluate(marked, tiny_ml_results(), T0 + timedelta(days=1), sha='7' * 64)
    # A server measurement of a checkpoint that is already on the board as an owner-marked row is not repeated.
    duplicate = make_run('same checkpoint', {}, ended=T0 - timedelta(days=1))
    evaluate(duplicate, tiny_ml_results(), T0, sha=SHA)
    # Opting in without a complete marked result still leaves the run on the board, measured by the track.
    opted_only = make_run('opted in only', {})
    assert client.put(f'/api/runs/{opted_only}/attributes/visibility/public_board_metrics', json={'value': True}).status_code == 200
    assert client.put(f'/api/runs/{opted_only}/attributes/visibility/public_note', json={'value': 'Baseline.'}).status_code == 200
    evaluate(opted_only, tiny_ml_results(), T0, sha='8' * 64)
    rows = {row['name']: row for row in board().json()['models']}
    assert set(rows) == {'marked', 'opted in only'}
    assert (rows['marked']['trust'], rows['marked']['en'], rows['marked']['checkpoint_sha256']) == (
        'verified', {'eff': 41.5, 'arc_easy': 38.2, 'blimp': 71.0, 'wiki_byte_ppl': 2.91}, SHA)
    assert rows['opted in only']['trust'] == 'track' and rows['opted in only']['public_note'] == 'Baseline.'
