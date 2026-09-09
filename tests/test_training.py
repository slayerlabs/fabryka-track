import io
import math
import time

import torch

from fabryka_track.training import TinyTransformer


def launch(client, **changes):
    datasets = client.get('/api/datasets').json()
    body = dict(name='Smoke test', mix=[{'dataset_id': datasets[0]['id'], 'weight': 60},
                                     {'dataset_id': datasets[1]['id'], 'weight': 40}],
                steps=10, batch_size=2, learning_rate=0.003, seed=42)
    body.update(changes)
    return client.post('/api/training', json=body)


def finished(client, run_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        run = client.get('/api/runs/' + run_id).json()
        if run['state'] not in ('queued', 'running', 'stopping'):
            return run
        time.sleep(.03)
    raise AssertionError('Training did not finish within 30 seconds')


def test_real_training_checkpoint_and_reproducibility(client):
    first = launch(client)
    assert first.status_code == 201
    run = finished(client, first.json()['id'])
    assert run['state'] == 'finished'
    assert run['metrics']['progress'][-1]['value'] == 100
    assert run['metrics']['train/loss'][-1]['value'] < run['metrics']['train/loss'][0]['value']
    assert all(math.isfinite(p['value']) for points in run['metrics'].values() for p in points)
    artifact = next(a for a in run['artifacts'] if a['name'] == 'model.pt')
    checkpoint = torch.load(io.BytesIO(client.get('/api/artifacts/' + artifact['id']).content), weights_only=True)
    model = TinyTransformer()
    model.load_state_dict(checkpoint['state_dict'])
    assert model(torch.tensor([[1, 2, 3]])).shape == (1, 3, 256)
    assert len(checkpoint['config']['mix'][0]['sha256']) == 64
    repeat = finished(client, launch(client).json()['id'])
    assert [p['value'] for p in repeat['metrics']['val/loss']] == [p['value'] for p in run['metrics']['val/loss']]


def test_mix_validation_and_dataset_upload(client):
    assert launch(client, mix=[]).status_code == 422
    assert launch(client, name='   ').status_code == 422
    assert launch(client, steps=2001).status_code == 422
    assert launch(client, mix=[{'dataset_id':'missing', 'weight':100}]).status_code == 422
    dataset = client.get('/api/datasets').json()[0]['id']
    assert launch(client, mix=[{'dataset_id':dataset,'weight':99}]).status_code == 422
    assert launch(client, mix=[{'dataset_id':dataset,'weight':50}]*2).status_code == 422
    assert client.post('/api/datasets', files={'file':('bad.txt', b'\xff'*120)}).status_code == 422
    assert client.post('/api/datasets', files={'file':('short.txt', b'abc')}).status_code == 422
    assert client.post('/api/datasets', files={'file':('large.txt', b'a'*2_000_001)}).status_code == 413
    body = ('A custom training text with punctuation and words. ' * 20).encode()
    uploaded = client.post('/api/datasets', files={'file':('my-text.txt',body)})
    assert uploaded.status_code == 201
    repeated = client.post('/api/datasets', files={'file':('same.txt',body)})
    assert repeated.json()['id'] == uploaded.json()['id']
    run = finished(client, launch(client, mix=[{'dataset_id':uploaded.json()['id'],'weight':100}]).json()['id'])
    assert run['state'] == 'finished'


def test_stop_training(client):
    run_id = launch(client, steps=2000).json()['id']
    assert client.post('/api/training/' + run_id + '/stop').status_code == 200
    run = finished(client, run_id)
    assert run['state'] == 'cancelled'
    assert run['artifacts'] == []
    assert client.post('/api/training/' + run_id + '/stop').json()['state'] == 'cancelled'


def test_leaderboard_ranks_completed_models(client):
    first = finished(client, launch(client, name='Higher score', seed=1).json()['id'])
    second = finished(client, launch(client, name='Another score', seed=2).json()['id'])
    for run_id in (first['id'], second['id']):
        assert client.patch('/api/training/' + run_id + '/visibility', json={'is_public': True}).status_code == 200
    board = client.get('/api/leaderboard')
    assert board.status_code == 200
    rows = board.json()['models']
    assert len(rows) >= 2
    assert rows[0]['rank'] == 1
    assert rows[0]['val_loss'] <= rows[1]['val_loss']
    assert rows[0]['mix'][0]['weight'] == 60
    assert client.get('/api/leaderboard?sort=throughput&order=desc').json()['models'][0]['throughput'] >= 0
    assert client.get('/api/leaderboard?sort=nope').status_code == 422


def test_causal_attention():
    model = TinyTransformer().eval()
    with torch.no_grad():
        first = model(torch.tensor([[10,20,30,40]]))
        second = model(torch.tensor([[10,20,99,98]]))
    assert torch.allclose(first[:, :2], second[:, :2])


def test_small_model_preset_trains(client):
    response = launch(client, name='Small model smoke test', model_size='small', steps=10)
    assert response.status_code == 201
    run = finished(client, response.json()['id'])
    assert run['state'] == 'finished'
    assert run['config']['model_size'] == 'small'
    assert '391,008' in run['config']['model']
    manifest = client.get('/api/training/' + response.json()['id'] + '/manifest')
    assert manifest.status_code == 200
    payload = manifest.json()
    assert payload['schema_version'] == 1
    assert payload['source'] == 'scratch'
    assert payload['model']['size'] == 'small'
    assert payload['training']['target_tokens'] == 100_000_000
    assert all(dataset['example'] for dataset in payload['datasets'])
    assert sum(dataset['weight'] for dataset in payload['datasets']) == 100
    source = client.get(payload['datasets'][0]['content_url'])
    assert source.status_code == 200
    assert source.headers['x-dataset-sha256'] == payload['datasets'][0]['sha256']
    assert source.headers['etag'] == '"' + payload['datasets'][0]['sha256'] + '"'
    assert client.get('/api/datasets/missing/content').status_code == 404


def test_chinchilla_plan_matches_model_and_short_training_context(client, monkeypatch):
    from fabryka_track import training
    monkeypatch.setattr(training.executor, 'submit', lambda *args: None)
    for size in ('tiny', 'small'):
        response = launch(client, model_size=size, budget_mode='chinchilla', batch_size=8)
        assert response.status_code == 201
        run = client.get('/api/runs/' + response.json()['id']).json()
        cfg = run['config']
        parameters = sum(p.numel() for p in TinyTransformer(**training.MODEL_PRESETS[size]['architecture']).parameters())
        assert cfg['parameters'] == parameters
        assert cfg['planned_training_tokens'] >= 20 * parameters
        assert cfg['planned_training_tokens'] - 20 * parameters < 8 * cfg['training_context_length']
        assert cfg['steps'] > 2000
        manifest = client.get(response.json()['manifest_url']).json()
        assert manifest['training']['planned_training_tokens'] == cfg['planned_training_tokens']
    uploaded = client.post('/api/datasets', files={'file': ('short-context.txt', b'a' * 100)}).json()
    # Model contexts fit this source; exercise the shortened-context calculation directly too.
    body = training.TrainingInput(name='Short context', mix=[{'dataset_id': uploaded['id'], 'weight': 100}], budget_mode='chinchilla', model_size='small')
    plan = training.plan_training(body, [{'bytes': 50, 'weight': 100}])
    assert plan['training_context_length'] == 44
    assert plan['planned_training_tokens'] == plan['steps'] * body.batch_size * 44
    assert plan['planned_training_tokens'] >= 20 * plan['parameters']


def test_early_stopping_saves_actual_best_checkpoint(client):
    from fabryka_track.training import MODEL_PRESETS
    response = launch(client, steps=2000, model_size='small', batch_size=8)
    run = finished(client, response.json()['id'])
    assert run['state'] == 'finished'
    result = run['metadata']['training_result']
    assert result['stop_reason'] == 'early_stopping'
    assert result['best_step'] < result['completed_steps'] < 2000
    best = min(run['metrics']['val/loss'], key=lambda p: p['value'])
    assert result['best_step'] == best['step']
    assert result['best_val_loss'] == best['value']
    assert result['best_val_loss'] < run['metrics']['val/loss'][-1]['value']
    checkpoint_artifact = next(a for a in run['artifacts'] if a['name'] == 'model.pt')
    checkpoint = torch.load(io.BytesIO(client.get('/api/artifacts/' + checkpoint_artifact['id']).content), weights_only=True)
    model = TinyTransformer(**MODEL_PRESETS['small']['architecture']).eval()
    model.load_state_dict(checkpoint['state_dict'])
    # Independently reconstruct the held-out sample and evaluate downloaded weights.
    cfg = run['config']
    sources = []
    for source in cfg['mix']:
        raw = client.get('/api/datasets/' + source['id'] + '/content').content
        sources.append(torch.tensor(list(raw[int(len(raw) * .9):]), dtype=torch.long))
    rng = torch.Generator().manual_seed(cfg['seed'] + 1)
    length = min(cfg['context_length'], min(len(d)-1 for d in sources))
    choices = torch.multinomial(torch.tensor([d['weight'] / 100 for d in cfg['mix']]), 32, replacement=True, generator=rng)
    sequences = []
    for choice in choices.tolist():
        source = sources[choice]
        pos = torch.randint(len(source)-length, (1,), generator=rng).item()
        sequences.append(source[pos:pos+length+1])
    tokens = torch.stack(sequences)
    with torch.no_grad():
        loss = torch.nn.functional.cross_entropy(model(tokens[:, :-1]).reshape(-1, 256), tokens[:, 1:].reshape(-1)).item()
    assert abs(loss - result['best_val_loss']) < 1e-6
    assert checkpoint['best_step'] == best['step']
    recipe_artifact = next(a for a in run['artifacts'] if a['name'] == 'recipe.json')
    recipe = client.get('/api/artifacts/' + recipe_artifact['id']).json()
    assert recipe['status'] == 'finished'
    assert recipe['result'] == result
    assert client.patch('/api/training/' + run['id'] + '/visibility', json={'is_public': True}).status_code == 200
    board = client.get('/api/leaderboard').json()['models']
    assert next(r for r in board if r['id'] == run['id'])['val_loss'] == best['value']
    assert result['tokens_seen'] == result['completed_steps'] * cfg['batch_size'] * cfg['training_context_length']


def test_step_limit_still_saves_best_and_reuse_accounts_for_weights(client):
    run = finished(client, launch(client, steps=60, early_stopping=False).json()['id'])
    result = run['metadata']['training_result']
    assert result['stop_reason'] == 'step_limit'
    assert result['completed_steps'] == 60
    assert result['best_val_loss'] == min(p['value'] for p in run['metrics']['val/loss'])
    cfg = run['config']
    assert cfg['expected_max_source_reuse'] == max(cfg['planned_training_tokens'] * d['weight'] / 100 / int(d['bytes'] * .9) for d in cfg['mix'])
    assert launch(client, patience=0).status_code == 422
    assert launch(client, min_delta=-1).status_code == 422


def _documents(blob):
    return [d for d in blob.split(b"\n\n") if d.strip()]


def test_holdout_split_is_whole_document_and_deduplicated():
    from fabryka_track.training import _holdout_split
    docs_a = [f"A{i:02d}-".encode() + bytes((65 + i,)) * 96 for i in range(12)]
    docs_b = [docs_a[0]] + [f"B{i:02d}-".encode() + bytes((97 + i,)) * 96 for i in range(3)]
    source_a, source_b = b"\n\n".join(docs_a), b"\n\n".join(docs_b)
    originals = set(docs_a) | set(docs_b)
    seen = set()
    a_train, a_val = _holdout_split(source_a, 0, seen)
    b_train, b_val = _holdout_split(source_b, 0, seen)
    train_docs = _documents(a_train) + _documents(b_train)
    val_docs = _documents(a_val) + _documents(b_val)
    # Only whole original documents survive: the last-10% byte split cut mid-document.
    assert all(d in originals for d in train_docs + val_docs)
    # A document never lands in both train and validation (no train/eval leakage).
    assert set(train_docs).isdisjoint(val_docs)
    # Every multi-document source keeps a non-empty train and validation split.
    assert _documents(a_train) and _documents(a_val)
    assert _documents(b_train) and _documents(b_val)
    # The document shared across sources is kept exactly once (cross-source dedup).
    assert (train_docs + val_docs).count(docs_a[0]) == 1


def test_holdout_split_is_deterministic():
    from fabryka_track.training import _holdout_split
    docs = [f"D{i:02d}-".encode() + bytes((65 + i,)) * 80 for i in range(20)]
    source = b"\n\n".join(docs)
    assert _holdout_split(source, 7, set()) == _holdout_split(source, 7, set())


def test_dataset_listing_reads_metadata_only_and_counts_utf8(client):
    from sqlalchemy import event
    from fabryka_track.database import engine
    content = ('Zażółć gęślą jaźń 🦊\n' * 100).encode('utf-8')
    uploaded = client.post('/api/datasets', files={'file': ('polish.txt', content, 'text/plain')})
    assert uploaded.status_code == 201
    statements = []
    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'datasets' in statement:
            statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        response = client.get('/api/datasets')
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert response.status_code == 200
    row = next(d for d in response.json() if d['name'] == 'polish.txt')
    assert row['bytes'] == len(content)
    assert statements and all('datasets.content' not in sql for sql in statements)


def test_existing_dataset_sizes_are_backfilled(client):
    from sqlalchemy import text
    from fabryka_track.database import engine, create_tables
    with engine.begin() as connection:
        connection.execute(text('UPDATE datasets SET byte_count = NULL'))
    create_tables()
    with engine.connect() as connection:
        assert connection.execute(text('SELECT count(*) FROM datasets WHERE byte_count IS NULL OR byte_count != length(CAST(content AS BLOB))')).scalar() == 0
    assert client.get('/api/datasets').status_code == 200
