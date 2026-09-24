from conftest import sign_in
from test_training import launch, finished


def test_short_cpu_run_produces_multiple_periodic_checkpoints_and_exactly_one_best(client):
    run = finished(client, launch(client, steps=20, early_stopping=False).json()['id'])
    assert run['state'] == 'finished'
    rows = client.get('/api/runs/' + run['id'] + '/checkpoints').json()
    assert [r['step'] for r in rows] == sorted(r['step'] for r in rows)
    non_final = [r for r in rows if not r['is_best']]
    best = [r for r in rows if r['is_best']]
    assert len(non_final) >= 2
    assert len(best) == 1
    for r in rows:
        assert r['artifact_id']
        assert client.get('/api/artifacts/' + r['artifact_id']).status_code == 200
        assert r['val_loss'] is not None


def test_forking_from_a_checkpoint_sets_lineage_diffs_config_and_warm_starts_from_parent_weights(client):
    parent = finished(client, launch(client, steps=20, early_stopping=False).json()['id'])
    assert parent['state'] == 'finished'
    checkpoints = client.get('/api/runs/' + parent['id'] + '/checkpoints').json()
    non_final = [c for c in checkpoints if not c['is_best']]
    assert len(non_final) >= 2
    source = non_final[0]

    fork_response = launch(client, steps=20, early_stopping=False, learning_rate=0.001,
                            parent_run_id=parent['id'], checkpoint_id=source['id'])
    assert fork_response.status_code == 201
    forked = finished(client, fork_response.json()['id'])
    assert forked['state'] == 'finished'
    assert forked['parent_run_id'] == parent['id']
    assert forked['forked_from_checkpoint_id'] == source['id']
    assert forked['inherited_from']['parent_run_id'] == parent['id']
    assert forked['inherited_from']['checkpoint_id'] == source['id']
    # Only learning_rate was deliberately changed; every other config key (incl.
    # model_size) is identical to the parent's and must not show up as "changed".
    assert forked['inherited_from']['changed_keys'] == ['learning_rate']

    # A from-scratch run with the same seed, data and steps, but fresh random
    # weights instead of the parent's step-4 checkpoint. The first train/loss
    # point is measured before any optimizer step is applied, so it directly
    # reflects the starting weights: fresh-random vs. warm-started must differ.
    control = finished(client, launch(client, steps=20, early_stopping=False, learning_rate=0.001).json()['id'])
    assert forked['metrics']['train/loss'][0]['value'] != control['metrics']['train/loss'][0]['value']


def test_forking_from_a_checkpoint_on_a_private_or_unowned_run_returns_404(client):
    private_run = finished(client, launch(client, steps=20, early_stopping=False).json()['id'])
    assert client.patch('/api/training/' + private_run['id'] + '/visibility', json={'is_public': False}).status_code == 200
    checkpoint_id = client.get('/api/runs/' + private_run['id'] + '/checkpoints').json()[0]['id']

    sign_in(client, 'stranger')
    assert client.get('/api/runs/' + private_run['id'] + '/checkpoints').status_code == 404
    response = launch(client, steps=20, parent_run_id=private_run['id'], checkpoint_id=checkpoint_id)
    assert response.status_code == 404

    # Checkpoints of a running run remain owner-only even when its progress is public.
    sign_in(client)
    running = launch(client, steps=2000).json()['id']
    sign_in(client, 'stranger')
    assert client.get('/api/runs/' + running + '/checkpoints').status_code == 404
    response = launch(client, steps=20, parent_run_id=running, checkpoint_id='does-not-matter')
    assert response.status_code == 404
    sign_in(client)
    client.post('/api/training/' + running + '/stop')
    finished(client, running)
