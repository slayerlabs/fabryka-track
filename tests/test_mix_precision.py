import io

import pytest
import torch
from pydantic import ValidationError

from fabryka_track.training import TrainingInput
from test_training import finished

SHARES = [46.67, 27.78, 8.89, 7.78, 5.56, 3.32]


def recipe(**kwargs):
    return dict(name='Ivme English mixture', mix=[{'dataset_id': str(i), 'weight': w} for i, w in enumerate(SHARES)], **kwargs)


def test_exact_percentage_validation():
    assert [x.weight for x in TrainingInput(**recipe()).mix] == SHARES
    for invalid in [46.671, 0, -1, 100.01, float('inf'), float('nan')]:
        body = recipe()
        body['mix'][0]['weight'] = invalid
        with pytest.raises(ValidationError):
            TrainingInput(**body)
    body = recipe()
    body['mix'][0]['weight'] = 46.66
    with pytest.raises(ValidationError, match='add up to 100'):
        TrainingInput(**body)


def test_fractional_mix_survives_real_training_checkpoint_and_fork(client):
    mix = []
    for i, weight in enumerate(SHARES):
        content = (f'Source {i}: independent training text for a fractional English recipe. ' * 100).encode()
        dataset = client.post('/api/datasets', files={'file': (f'ivme-source-{i}.txt', content)}).json()
        mix.append({'dataset_id': dataset['id'], 'weight': weight})
    body = dict(name='Ivme precision smoke', mix=mix, steps=10, batch_size=2, early_stopping=False)
    response = client.post('/api/training', json=body)
    assert response.status_code == 201, response.text
    run = finished(client, response.json()['id'])
    assert run['state'] == 'finished'
    assert [d['weight'] for d in run['config']['mix']] == SHARES
    artifact = next(a for a in run['artifacts'] if a['name'] == 'model.pt')
    checkpoint = torch.load(io.BytesIO(client.get('/api/artifacts/' + artifact['id']).content), weights_only=True)
    assert [d['weight'] for d in checkpoint['config']['mix']] == SHARES
    saved = client.get('/api/runs/' + run['id'] + '/checkpoints').json()[0]
    response = client.post('/api/training', json={**body, 'parent_run_id': run['id'], 'checkpoint_id': saved['id']})
    assert response.status_code == 201, response.text
    fork = finished(client, response.json()['id'])
    assert fork['state'] == 'finished'
    assert [d['weight'] for d in fork['config']['mix']] == SHARES
