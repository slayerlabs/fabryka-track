from conftest import sign_in
from fabryka_track.database import SessionLocal
from fabryka_track.models import BenchmarkEvaluation, Run
from test_training import finished, launch


def evaluation(run, **kwargs):
    with SessionLocal() as session:
        row = BenchmarkEvaluation(run_id=run['id'], status=kwargs.get('status', 'finished'),
            mode=kwargs.get('mode', 'full'), tasks=['piqa'],
            results={'piqa': {'accuracy': .55, 'acc_norm': .53, 'samples': 1838,
                              'sample_digest': 'a'*64, 'dataset_revisions': {'baber/piqa': 'revision'},
                              'raw_samples': 'PRIVATE PROMPT'}},
            provenance={'checkpoint_sha256': 'b'*64, 'checkpoint_step': 10, 'fewshot': 0, 'seed': 42,
                        'parameters': 100, 'harness_version': '0.4.13', 'protocol': 'test-protocol',
                        'scoring_implementation': 'byte-sliding', 'lease': 'PRIVATE LEASE',
                        'checkpoint': '/private/model.pt', 'runner': 'PRIVATE HOST'})
        session.add(row);session.commit()
        return row.id


def test_published_reports_are_anonymous_and_keep_metric_identity(client):
    run = finished(client, launch(client).json()['id'])
    eid = evaluation(run)
    client.post('/api/auth/logout')
    response = client.get('/api/benchmark-results')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    report = response.json()['items'][0]
    assert report['id'] == eid
    assert [(m['metric'], m['value']) for m in report['measurements']] == [('accuracy', .55), ('acc_norm', .53)]
    assert report['measurements'][1]['metric_label'].endswith('acc_norm,none')
    assert report['checkpoint']['checkpoint_step'] == 10
    assert report['evidence']['fewshot'] == 0
    assert 'PRIVATE' not in response.text and '/private/' not in response.text
    assert 'lease' not in report['evidence'] and 'runner' not in report['evidence']
    assert client.get(report['source_url']).json() == report
    page = client.get('/benchmark-results')
    assert page.status_code == 200
    assert 'Published benchmark results' in page.text and '<html lang="en">' in page.text
    assert client.get('/assets/published-benchmarks.js').status_code == 200


def test_public_report_filters_status_mode_and_current_run_visibility(client):
    run = finished(client, launch(client).json()['id'])
    full = evaluation(run)
    smoke = evaluation(run, mode='smoke')
    evaluation(run, status='running')
    evaluation(run, status='failed')
    assert [r['id'] for r in client.get('/api/benchmark-results').json()['items']] == [full]
    assert [r['id'] for r in client.get('/api/benchmark-results?mode=smoke').json()['items']] == [smoke]
    assert client.patch('/api/training/'+run['id']+'/visibility', json={'is_public':False}).status_code == 200
    assert client.get('/api/benchmark-results').json()['total'] == 0
    assert client.get('/api/benchmark-results/'+full).status_code == 404
    sign_in(client, 'other')
    assert client.get('/api/benchmark-results/'+full).status_code == 404
    with SessionLocal() as session:
        stored = session.get(Run, run['id']);stored.is_public = True;stored.state = 'running';session.commit()
    assert client.get('/api/benchmark-results').json()['total'] == 0


def test_report_pagination_is_bounded_and_stable(client):
    run = finished(client, launch(client).json()['id'])
    first, second = evaluation(run), evaluation(run)
    response = client.get('/api/benchmark-results?limit=1').json()
    assert response['total'] == 2 and response['items'][0]['id'] == second
    assert client.get('/api/benchmark-results?limit=1&offset=1').json()['items'][0]['id'] == first
    assert client.get('/api/benchmark-results?offset=2').json()['items'] == []
    assert client.get('/api/benchmark-results?limit=101').status_code == 422
    assert client.get('/api/benchmark-results?mode=all').status_code == 422


def test_report_preserves_zero_and_omits_missing_failed_and_invalid_metrics(client):
    run = finished(client, launch(client).json()['id'])
    eid = evaluation(run)
    with SessionLocal() as session:
        row = session.get(BenchmarkEvaluation, eid)
        row.tasks = ['piqa', 'arc_easy', 'hellaswag']
        row.results = {'piqa': {'accuracy': 0, 'acc_norm': None, 'samples': 0},
                       'arc_easy': {'error':'failed', 'accuracy': .9},
                       'hellaswag': {'accuracy': 3, 'acc_norm': '0.50', 'bpb': True}}
        session.commit()
    measurements = client.get('/api/benchmark-results/'+eid).json()['measurements']
    assert len(measurements) == 1
    assert measurements[0]['metric'] == 'accuracy' and measurements[0]['value'] == 0
    assert measurements[0]['samples'] == 0
