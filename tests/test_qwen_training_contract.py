import pytest

from fabryka_track.training import TrainingInput


def qwen_body(**overrides):
    body = {
        'name': 'ARC-E FineWeb-Edu pilot', 'compute': 'runpod', 'model_size': 'qwen149m',
        'mix': [], 'tokenized_shards': [
            {'path': 'fineweb-edu-r0a/train-00000.bin', 'sha256': 'a' * 64, 'tokens': 100_000},
            {'path': 'fineweb-edu-r0a/validation-00000.bin', 'sha256': 'b' * 64, 'tokens': 10_000, 'split': 'validation'},
        ],
    }
    body.update(overrides)
    return body


def test_qwen_accepts_immutable_shard_contract():
    request = TrainingInput(**qwen_body())
    assert request.mix == []
    assert request.tokenized_shards[0].path == 'fineweb-edu-r0a/train-00000.bin'


def test_qwen_rejects_studio_mix():
    with pytest.raises(ValueError, match='immutable tokenized-shard'):
        TrainingInput(**qwen_body(mix=[{'dataset_id': 'x', 'weight': 100}]))


def test_other_models_still_require_a_dataset():
    with pytest.raises(ValueError, match='Select at least one dataset'):
        TrainingInput(name='Small model with no data', model_size='small')


def test_qwen_requires_a_validation_shard():
    body = qwen_body(tokenized_shards=[{'path': 'train.bin', 'sha256': 'a' * 64, 'tokens': 100_000}])
    with pytest.raises(ValueError, match='separate train and validation'):
        TrainingInput(**body)
