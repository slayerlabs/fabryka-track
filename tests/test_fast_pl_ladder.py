import hashlib
import importlib.util
import json
import pathlib
from types import SimpleNamespace

import pytest
import torch

from fabryka_track.fast_pl_ladder import COMPONENTS, PROTOCOL, evaluate, pl_score


def _write_pack(tmp_path, key, rows):
    raw = ('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n').encode()
    (tmp_path / (key + '.jsonl')).write_bytes(raw)
    manifest = {'protocol': PROTOCOL, 'components': {key: {'sha256': hashlib.sha256(raw).hexdigest()}}, 'sources': {key: {}}}
    (tmp_path / 'manifest.json').write_text(json.dumps(manifest))
    return raw


def test_pl_score_requires_every_component_and_keeps_negatives():
    assert sum(c['weight'] for c in COMPONENTS.values()) == pytest.approx(1)
    results = {k: {'normalized': 0.5} for k in COMPONENTS}
    assert pl_score(results) == pytest.approx(.5)
    results['pl_lm']['normalized'] = -1  # weight .60
    assert pl_score(results) == pytest.approx(.5 * .40 - 1 * .60)
    del results['pl_induction']
    assert pl_score(results) is None


def test_pl_lm_uniform_model_scores_each_byte_once_and_verifies_pack(tmp_path, monkeypatch):
    _write_pack(tmp_path, 'pl_lm', [{'text': 'zażółć gęślą jaźń ' * 20}])
    monkeypatch.setenv('TRACK_FAST_PL_LADDER_DIR', str(tmp_path))
    model = SimpleNamespace(context_length=7, _device=torch.device('cpu'), model=lambda x: torch.zeros((*x.shape, 256)))
    result = evaluate('pl_lm', model, 'full')
    assert result['bpb'] == pytest.approx(8)          # uniform 256-way byte model = 8 bits/byte
    assert result['normalized'] == pytest.approx(0, abs=1e-6)
    (tmp_path / 'pl_lm.jsonl').write_text('{}')
    with pytest.raises(ValueError, match='checksum'):
        evaluate('pl_lm', model, 'full')


def test_pair_component_prefers_higher_probability_continuation(tmp_path, monkeypatch):
    # A model whose logits increase with byte value prefers continuations of higher-valued bytes.
    logits = torch.arange(256).float()
    model = SimpleNamespace(context_length=16, _device=torch.device('cpu'), model=lambda x: logits.expand(*x.shape, 256))
    _write_pack(tmp_path, 'pl_multiblimp', [{'context': '', 'good': 'zz', 'bad': 'aa'},
                                            {'context': 'to ', 'good': 'zz', 'bad': 'aa'}])
    monkeypatch.setenv('TRACK_FAST_PL_LADDER_DIR', str(tmp_path))
    result = evaluate('pl_multiblimp', model, 'full')
    assert result['accuracy'] == pytest.approx(1.0)
    assert result['normalized'] > 0 and result['mean_margin_nats'] > 0
    assert result['comparisons'] == 2


def test_synthetic_induction_pack_is_deterministic_and_well_formed():
    spec = importlib.util.spec_from_file_location(
        'build_fast_pl_ladder', pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'build_fast_pl_ladder.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    a, b = module.induction_pairs(), module.induction_pairs()
    assert a == b and len(a) == module.INDUCTION_ITEMS       # deterministic
    for item in a:
        assert item['good'] != item['bad']                   # a real forced choice
        assert item['context'].startswith(item['context'][0]) and item['context'].endswith(item['context'][0])
