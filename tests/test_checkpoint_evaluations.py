import json
import math
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select

from conftest import sign_in
from fabryka_track import benchmarks, wikitext_suite
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Artifact, BenchmarkEvaluation, Checkpoint, Project, Run
from fabryka_track.settings import settings


@pytest.fixture
def snapshot(client, monkeypatch):
    monkeypatch.setattr(settings, 'benchmark_runner_tokens', json.dumps({'test': 'r' * 40}))
    with SessionLocal() as db:
        owner = db.scalar(select(Account).where(Account.username == 'tester'))
        project = Project(name='checkpoint evaluation'); db.add(project); db.flush()
        run = Run(id=str(uuid4()), owner_id=owner.id, project_id=project.id, name='live byte model',
                  state='running', metadata_={'engine': 'tiny-transformer'}, config={})
        db.add(run); db.flush()
        folder = settings.artifact_dir / run.id; folder.mkdir(parents=True)
        path = folder / 'checkpoint-4.pt'; path.write_bytes(b'pinned snapshot')
        artifact = Artifact(run_id=run.id, name=path.name, storage_key=f'{run.id}/{path.name}', size=path.stat().st_size)
        db.add(artifact); db.flush()
        checkpoint = Checkpoint(run_id=run.id, step=4, artifact_id=artifact.id)
        db.add(checkpoint); db.commit()
        return {'run_id': run.id, 'checkpoint_id': checkpoint.id, 'artifact_id': artifact.id, 'path': path}


def queue(client, snapshot, **changes):
    return client.post(f"/api/runs/{snapshot['run_id']}/benchmarks", json={
        'suite': 'wikitext2', 'mode': 'full', 'checkpoint_id': snapshot['checkpoint_id'], **changes})


def finish(eid):
    with SessionLocal() as db:
        row = db.get(BenchmarkEvaluation, eid)
        row.status = 'finished'
        row.results = {'wikitext2': {'byte_perplexity': 2., 'bits_per_byte': 1., 'num_bytes': 20, 'num_documents': 2}}
        db.commit()


def test_selected_live_checkpoint_and_reuse_isolate_split_mode_and_identity(client, snapshot):
    first = queue(client, snapshot)
    assert first.status_code == 202
    first = first.json(); finish(first['id'])
    assert queue(client, snapshot).json()['id'] == first['id']
    test = queue(client, snapshot, split='test').json()
    assert test['id'] != first['id'] and test['results'] == {}
    finish(test['id'])
    smoke = queue(client, snapshot, mode='smoke').json()
    assert smoke['id'] not in (first['id'], test['id']) and smoke['results'] == {}
    finish(smoke['id'])
    with SessionLocal() as db:
        alias = Checkpoint(run_id=snapshot['run_id'], artifact_id=snapshot['artifact_id'], step=4)
        db.add(alias); db.commit(); alias_id = alias.id
    alias = queue(client, snapshot, checkpoint_id=alias_id).json()
    assert alias['id'] != first['id'] and alias['results'] == {}
    assert alias['provenance']['checkpoint_id'] == alias_id


def test_checkpoint_ownership_path_and_format_boundaries(client, snapshot, tmp_path):
    with SessionLocal() as db:
        run = db.get(Run, snapshot['run_id'])
        other = Run(id=str(uuid4()), owner_id=run.owner_id, project_id=run.project_id, name='other', metadata_={'engine': 'tiny-transformer'})
        db.add(other); db.commit(); other_id = other.id
    wrong = {**snapshot, 'run_id': other_id}
    assert queue(client, wrong).status_code == 404
    sign_in(client, 'outsider')
    assert queue(client, snapshot).status_code == 404
    sign_in(client)
    with SessionLocal() as db:
        artifact = db.get(Artifact, snapshot['artifact_id']); artifact.run_id = other_id; db.commit()
    assert queue(client, snapshot).status_code == 409
    outside = tmp_path / 'outside.pt'; outside.write_bytes(b'outside')
    with SessionLocal() as db:
        artifact = db.get(Artifact, snapshot['artifact_id']); artifact.run_id = snapshot['run_id']
        original_key = artifact.storage_key; artifact.storage_key = str(outside); db.commit()
    assert queue(client, snapshot).status_code == 409
    with SessionLocal() as db:
        artifact = db.get(Artifact, snapshot['artifact_id']); artifact.storage_key = original_key; artifact.name = 'weights.safetensors'; db.commit()
    assert queue(client, snapshot).status_code == 409


def test_remote_capability_gate_pinned_download_and_lease_identity(client, snapshot):
    row = queue(client, snapshot).json()
    headers = {'Authorization': 'Bearer ' + 'r' * 40}
    root = '/api/benchmark-runner'
    assert client.post(root + '/claim', headers=headers).json()['job'] is None
    job = client.post(root + '/claim', json={'protocols': [wikitext_suite.PROTOCOL]}, headers=headers).json()['job']
    params = {'lease': job['lease']}
    response = client.get(f"{root}/{row['id']}/checkpoint", params=params, headers=headers)
    assert response.content == b'pinned snapshot'
    forged = {'checkpoint_id': str(uuid4()), 'artifact_id': str(uuid4()), 'checkpoint_sha256': 'x',
              'protocol': 'wrong', 'dataset_split': 'test', 'dataset_revisions': {}, 'context_policy': 'wrong'}
    assert client.post(f"{root}/{row['id']}/progress", json={**params, 'provenance': forged}, headers=headers).status_code == 200
    saved = client.get(f"/api/runs/{snapshot['run_id']}/benchmarks").json()[0]
    assert all(saved['provenance'][k] == row['provenance'][k] for k in forged)
    snapshot['path'].write_bytes(b'overwritten snapshot')
    assert client.get(f"{root}/{row['id']}/checkpoint", params=params, headers=headers).status_code == 409


def test_mutated_checkpoint_is_failed_before_remote_claim(client, snapshot):
    row = queue(client, snapshot).json()
    snapshot['path'].write_bytes(b'changed')
    response = client.post('/api/benchmark-runner/claim', json={'protocols': [wikitext_suite.PROTOCOL]},
                           headers={'Authorization': 'Bearer ' + 'r' * 40})
    assert response.json()['job'] is None
    saved = client.get(f"/api/runs/{snapshot['run_id']}/benchmarks").json()[0]
    assert saved['id'] == row['id'] and saved['status'] == 'failed'
    assert saved['provenance']['checkpoint_sha256'] == row['provenance']['checkpoint_sha256']


def test_checkpoint_evaluations_remain_private_on_public_finished_run(client, snapshot):
    row = queue(client, snapshot).json()
    finish(row['id'])
    with SessionLocal() as db:
        run = db.get(Run, snapshot['run_id']); run.state = 'finished'; run.is_public = True; db.commit()
    url = f"/api/runs/{snapshot['run_id']}/benchmarks"
    assert client.get(url).json()[0]['id'] == row['id']
    sign_in(client, 'outsider')
    assert client.get(url).json() == []
    client.post('/api/auth/logout')
    assert client.get(url).json() == []


def byte_model(path):
    torch = pytest.importorskip('torch')
    pytest.importorskip('lm_eval')
    from fabryka_track.native_model import TinyTransformer
    from fabryka_track.benchmark_model import ByteCheckpointLM
    cfg = {'width': 8, 'layers': 1, 'heads': 2, 'context_length': 4,
           'parameters': 1000, 'batch_size': 1, 'mix': [{'bytes': 100}]}
    torch.save({'config': cfg, 'best_step': 4, 'state_dict': TinyTransformer(**{
        k: cfg[k] for k in ('width', 'layers', 'heads', 'context_length')}).state_dict()}, path)
    return ByteCheckpointLM(path, rolling_policy='harness')


def test_rolling_scores_each_unicode_byte_once_with_official_context_and_document_reset(tmp_path):
    import torch
    model = byte_model(tmp_path / 'model.pt')
    class PositionSensitive(torch.nn.Module):
        def forward(self, x):
            logits = torch.zeros((*x.shape, 256))
            logits.scatter_(2, x.unsqueeze(-1), torch.arange(1, x.shape[1] + 1).float()[None, :, None].expand(x.shape[0], -1, 1))
            return logits
    model.model = PositionSensitive()
    text = 'ą€xyzAB'; tokens = list(text.encode('utf-8'))
    # C=4: full blocks start with one context byte; final partial block gets
    # the extra left context. The boundary splits a multibyte code point.
    windows = [([32] + tokens[:3], tokens[:4], 0), (tokens[3:7], tokens[4:8], 0), (tokens[5:9], tokens[8:10], 2)]
    expected = 0.
    for inputs, targets, start in windows:
        scores = model.model(torch.tensor([inputs])).log_softmax(-1)[0]
        expected += sum(scores[start + i, target].item() for i, target in enumerate(targets))
    actual = model.loglikelihood_rolling([SimpleNamespace(args=(text,)), SimpleNamespace(args=(text,))])
    assert actual == pytest.approx([expected, expected], abs=1e-5)
    assert model.loglikelihood_rolling([SimpleNamespace(args=('',))]) == [0.]


def test_wikitext_aggregates_original_utf8_bytes_before_detokenization(tmp_path):
    import torch
    model = byte_model(tmp_path / 'model.pt')
    class Uniform(torch.nn.Module):
        def forward(self, x):return torch.zeros((*x.shape, 256))
    model.model = Uniform()
    pages = [{'page': 'ą @-@ ę . \n'}, {'page': 'z'}]
    scored_bytes = len('ą-ę.\n'.encode()) + 1
    original_bytes = sum(len(doc['page'].encode()) for doc in pages)
    result = wikitext_suite.score_documents(model, pages)
    assert result['num_bytes'] == original_bytes and result['num_documents'] == 2
    assert result['bits_per_byte'] == pytest.approx(8 * scored_bytes / original_bytes)
    assert result['byte_perplexity'] == pytest.approx(math.exp(math.log(256) * scored_bytes / original_bytes))


def test_real_local_worker_scores_selected_snapshot_and_rejects_mutation(client, snapshot, monkeypatch):
    byte_model(snapshot['path'])
    import datasets
    from fabryka_track.benchmark_worker import run
    monkeypatch.setattr(datasets, 'load_dataset', lambda *args, **kwargs: [{'page': 'ą @-@ z'}, {'page': 'other page'}])
    row = queue(client, snapshot).json()
    run(row['id'])
    saved = client.get(f"/api/runs/{snapshot['run_id']}/benchmarks").json()[0]
    assert saved['status'] == 'finished'
    result = saved['results']['wikitext2']
    assert result['num_bytes'] == len('ą @-@ zother page'.encode())
    assert result['num_documents'] == 2 and math.isfinite(result['byte_perplexity'])
    assert saved['provenance']['checkpoint_id'] == snapshot['checkpoint_id']
    next_row = queue(client, snapshot, split='test').json()
    snapshot['path'].write_bytes(b'mutated after enqueue')
    from fastapi import HTTPException
    with pytest.raises(HTTPException, match='hash mismatch'):
        run(next_row['id'])


def test_remote_worker_round_trip_preserves_split_and_scores_downloaded_checkpoint(client, snapshot, monkeypatch, tmp_path):
    byte_model(snapshot['path'])
    import datasets
    from fabryka_track.benchmark_worker import run
    monkeypatch.setattr(datasets, 'load_dataset', lambda *args, **kwargs: [{'page': 'remote ą page'}])
    row = queue(client, snapshot, split='test').json()
    headers = {'Authorization': 'Bearer ' + 'r' * 40}
    root = '/api/benchmark-runner'
    job = client.post(root + '/claim', json={'protocols': [wikitext_suite.PROTOCOL]}, headers=headers).json()['job']
    path = tmp_path / 'download.pt'
    response = client.get(f"{root}/{row['id']}/checkpoint", params={'lease': job['lease']}, headers=headers)
    path.write_bytes(response.content)
    job.update(checkpoint=str(path), device='cpu')
    def report(**values):
        values.pop('ended_at', None)
        response = client.post(f"{root}/{row['id']}/progress", json={**values, 'lease': job['lease']}, headers=headers)
        assert response.status_code == 200, response.text
    run(row['id'], job=job, reporter=report)
    saved = client.get(f"/api/runs/{snapshot['run_id']}/benchmarks").json()[0]
    assert saved['status'] == 'finished'
    assert saved['results']['wikitext2']['dataset_split'] == 'test'
    assert saved['results']['wikitext2']['num_bytes'] == len('remote ą page'.encode())
    assert saved['provenance']['checkpoint_sha256'] == benchmarks.checkpoint_digest(path)
    assert saved['provenance']['checkpoint_id'] == snapshot['checkpoint_id']
