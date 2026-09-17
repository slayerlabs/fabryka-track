import math

import pytest
from conftest import sign_in
from test_training import finished, launch
from fabryka_track import benchmarks
from fabryka_track.database import SessionLocal
from fabryka_track.models import BenchmarkEvaluation
from fabryka_track.tiny_ml_suite import scores, summarize_wikitext, REVISIONS, PROTOCOL


def measurements():
    return {'blimp': {'accuracy': .8128}, 'arc_easy': {'accuracy': .5707, 'acc_norm': .9},
            'wikitext': {'byte_perplexity': 1.86, 'bpb': math.log2(1.86)},
            'aci': {'aci_score': 62.5, 'samples': 5000}}


def test_frozen_reference_matches_glint_and_rejects_partial_scores():
    result = scores(measurements(), 125_000_000)
    assert result['overall'] == pytest.approx(79.45)
    assert result['efficiency'] == pytest.approx(80.0576931108467)
    assert scores(measurements(), 1000)['size_multiplier'] == 1.5
    assert scores(measurements(), 150_000_000)['size_multiplier'] == 1
    assert scores({'blimp': {'accuracy': .8}}, 8_000_000) is None
    for invalid in (float('nan'), float('inf'), -1, 0, True):
        rows = measurements(); rows['wikitext']['byte_perplexity'] = invalid
        assert scores(rows, 8_000_000) is None
    rows = measurements(); rows['arc_easy']['error'] = 'failed'
    assert scores(rows, 8_000_000) is None
    for invalid in (float('nan'), float('inf'), -1, 101, True):
        rows = measurements(); rows['aci']['aci_score'] = invalid
        assert scores(rows, 8_000_000) is None
    rows = measurements(); rows['aci']['samples'] = 0
    assert scores(rows, 8_000_000) is None
    rows = measurements(); del rows['aci']
    assert scores(rows, 8_000_000) is None
    # ACI gates eligibility but never alters the historical three-metric aggregate.
    rows = measurements(); rows['aci']['aci_score'] = 0
    assert scores(rows, 125_000_000) == result


def test_wiki_uses_byte_perplexity_not_word_perplexity():
    output = {'results': {'wikitext': {'byte_perplexity,none': 2, 'bits_per_byte,none': 1,
                                      'word_perplexity,none': 100}},
              'samples': {'wikitext': [{}, {}]}}
    result = summarize_wikitext(output)
    assert len(result.pop('sample_digest')) == 64
    assert result == {'byte_perplexity': 2, 'bpb': 1, 'word_perplexity': 100, 'samples': 2, 'unit': 'documents'}


def test_private_suite_cannot_leak_through_public_run_or_reports(client):
    run = finished(client, launch(client, auto_benchmark=False).json()['id'])
    url = '/api/runs/' + run['id'] + '/benchmarks'
    response = client.post(url, json={'suite': 'tiny_ml', 'mode': 'full'})
    assert response.status_code == 202, response.text
    entry = response.json(); eid = entry['id']
    assert entry['tasks'] == ['wikitext', 'blimp', 'arc_easy', 'aci']
    assert entry['provenance']['dataset_revisions'] == REVISIONS
    assert entry['provenance']['visibility'] == 'private'
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, eid)
        row.results = measurements(); row.status = 'finished'
        db.commit()
    assert client.get('/api/benchmarks/tiny-ml').json()['items'][0]['id'] == eid
    assert client.get(url).json()[0]['id'] == eid
    assert client.get('/api/benchmark-results/' + eid).status_code == 404
    assert not client.get('/api/benchmark-results').json()['items']
    client.post('/api/auth/logout')
    assert client.get('/api/benchmarks/tiny-ml').status_code == 401
    assert client.get(url).json() == []
    sign_in(client, 'second')
    assert client.get('/api/benchmarks/tiny-ml').json()['items'] == []
    assert client.get(url).json() == []


def test_smoke_is_never_ranked(client):
    run = finished(client, launch(client, auto_benchmark=False).json()['id'])
    entry = client.post('/api/runs/' + run['id'] + '/benchmarks',
                        json={'suite': 'tiny_ml', 'mode': 'smoke'}).json()
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, entry['id']); row.results = measurements(); row.status = 'finished'; db.commit()
    assert client.get('/api/benchmarks/tiny-ml').json()['items'] == []
    assert client.get('/api/runs/' + run['id'] + '/benchmarks').json()[0]['tiny_ml_score'] is None


def test_worker_capability_and_private_provenance_are_enforced(client):
    from fabryka_track.api import app
    from fabryka_track import benchmark_remote
    run = finished(client, launch(client, auto_benchmark=False).json()['id'])
    entry = client.post('/api/runs/' + run['id'] + '/benchmarks',
                        json={'suite': 'tiny_ml', 'mode': 'full'}).json()
    app.dependency_overrides[benchmark_remote.worker] = lambda: 'fixture-worker'
    try:
        assert client.post('/api/benchmark-runner/claim').json()['job'] is None
        job = client.post('/api/benchmark-runner/claim', json={'protocols': [PROTOCOL]}).json()['job']
        assert job['id'] == entry['id']
        response = client.post('/api/benchmark-runner/' + job['id'] + '/progress', json={
            'lease': job['lease'], 'provenance': {'visibility': 'public', 'protocol': 'other'}})
        assert response.status_code == 200
        with SessionLocal() as db:
            row = db.get(BenchmarkEvaluation, job['id'])
            assert row.provenance['visibility'] == 'private'
            assert row.provenance['protocol'] == PROTOCOL
    finally:
        app.dependency_overrides.pop(benchmark_remote.worker, None)


def test_old_protocol_is_history_not_new_suite_eligibility(client):
    run = finished(client, launch(client, auto_benchmark=False).json()['id'])
    url = '/api/runs/' + run['id'] + '/benchmarks'
    entry = client.post(url, json={'suite': 'tiny_ml', 'mode': 'full'}).json()
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, entry['id'])
        row.provenance = {**row.provenance, 'protocol': 'tiny-ml-en-v1-byte-sliding'}
        row.results = measurements(); row.status = 'finished'
        db.commit()
    assert client.get('/api/benchmarks/tiny-ml').json()['items'] == []
    history = client.get(url).json()
    assert history[0]['id'] == entry['id']
    assert history[0]['tiny_ml_score'] is None
