from types import SimpleNamespace

import numpy as np
import pytest
import torch
from torch.nn import functional as F

from fabryka_track import aci_suite as aci
from fabryka_track.native_model import TinyTransformer


def sample(item_id='one'):
    return {'id': item_id, 'context': 'a b c', 'question': '?',
            'segments': [{'id': 0, 'charStart': 0, 'charEnd': 1},
                         {'id': 1, 'charStart': 2, 'charEnd': 3},
                         {'id': 2, 'charStart': 4, 'charEnd': 5}],
            'relatedSegmentIds': [0, 2], 'unrelatedSegmentIds': [1], 'keyLinkPairs': [[0, 2]]}


@pytest.mark.parametrize('device', ['cpu'] + (['cuda'] if torch.cuda.is_available() else []))
def test_eager_logits_match_native_and_frozen_model_has_real_gradients(device):
    with torch.random.fork_rng():
        torch.manual_seed(7)
        model = TinyTransformer(width=16, layers=2, heads=4, context_length=16).eval().to(device)
    model.requires_grad_(False)
    inputs = torch.tensor([list('a b café?'.encode())], device=device)
    with torch.no_grad():
        expected = model(inputs)
    with torch.enable_grad():
        logits, attentions = aci.eager_forward(model, inputs)
        torch.testing.assert_close(logits, expected, rtol=2e-5, atol=2e-6)
        loss = F.cross_entropy(logits[:, :-1].reshape(-1, 256), inputs[:, 1:].reshape(-1))
        gradients = torch.autograd.grad(loss, attentions)
        saliency = aci.compute_saliency_matrix(attentions, gradients)
    assert np.isfinite(saliency).all() and saliency.sum() > 0
    assert np.count_nonzero(np.triu(saliency, 1)) == 0
    # The last query has no next-byte target and therefore contributes no saliency.
    np.testing.assert_array_equal(saliency[-1], 0)
    assert all(not parameter.requires_grad and parameter.grad is None for parameter in model.parameters())
    with torch.no_grad():
        torch.testing.assert_close(model(inputs), expected, rtol=0, atol=0)


def test_saliency_takes_absolute_products_before_summing_heads_and_layers():
    attention = torch.tensor([[[[.5, 0], [.25, .75]], [[.5, 0], [.25, .75]]]])
    gradient = torch.tensor([[[[2., 4], [-4, 2]], [[-2., -4], [4, -2]]]])
    actual = aci.compute_saliency_matrix([attention, attention], [gradient, gradient])
    np.testing.assert_array_equal(actual, [[4, 0], [4, 6]])


def test_segment_priority_and_linkage_match_reference_math_and_half_open_spans():
    saliency = np.array([[1, 0, 0, 0], [2, 1, 0, 0], [3, 4, 1, 0], [5, 6, 7, 1]], dtype=np.float32)
    item = {'segments': [{'id': 0, 'charStart': 0, 'charEnd': 1},
                         {'id': 1, 'charStart': 1, 'charEnd': 2},
                         {'id': 2, 'charStart': 2, 'charEnd': 3}],
            'relatedSegmentIds': [1, 2], 'unrelatedSegmentIds': [0], 'keyLinkPairs': [[1, 2], [1, 99]]}
    offsets = [(0, 1), (1, 2), (2, 3), (3, 4)]
    result = aci.segment_scores(saliency, offsets, item)
    assert result['priority_score'] == pytest.approx(100 * 9.5 / (9.5 + 11 + aci.EPS))
    control = 5 / (2 + aci.EPS)
    assert result['linkage_score'] == pytest.approx(100 * 2 / (2 + control + aci.EPS))
    assert result['valid_link_pairs'] == 1
    item['keyLinkPairs'] = [[1, 99]]
    assert aci.segment_scores(saliency, offsets, item)['linkage_score'] is None
    item['unrelatedSegmentIds'] = [99]
    assert aci.segment_scores(saliency, offsets, item) is None


def test_utf8_offsets_preserve_partial_multibyte_character_at_truncation():
    tokens, offsets = aci.byte_tokens_and_offsets('aé🙂z', 5)
    assert tokens == list('aé🙂z'.encode()[:5])
    assert offsets == [(0, 1), (1, 2), (1, 2), (2, 3), (2, 3)]
    assert aci.char_span_to_token_indices(offsets, 1, 2) == [1, 2]
    assert aci.char_span_to_token_indices(offsets, 2, 3) == [3, 4]
    assert aci.char_span_to_token_indices(offsets, 3, 4) == []


def test_evaluation_scores_frozen_model_and_accounts_for_truncation_and_skips():
    with torch.random.fork_rng():
        torch.manual_seed(11)
        model = TinyTransformer(width=8, layers=1, heads=2, context_length=8).eval()
    model.requires_grad_(False)
    adapter = SimpleNamespace(model=model, context_length=8)
    valid = sample()
    valid['question'] = 'long question'
    valid['keyLinkPairs'] = [[0, 99]]
    invalid = sample('missing-unrelated')
    invalid['segments'][1].update(charStart=20, charEnd=21)
    with torch.no_grad():
        result = aci.evaluate(adapter, 'full', rows=[valid, invalid])
    assert (result['samples'], result['attempted'], result['skipped'], result['errors']) == (1, 2, 1, 0)
    assert result['skip_reasons'] == {'empty_segment_tokens': 1}
    assert result['truncated'] == 1
    assert result['max_length'] == 8
    assert result['linkage_samples'] == 0
    assert result['linkage_score'] == 50
    assert 0 <= result['priority_score'] <= 100
    assert result['aci_score'] == (result['priority_score'] + 50) / 2
    assert all(parameter.grad is None and not parameter.requires_grad for parameter in model.parameters())
    with pytest.raises(aci.NoValidItems) as missing:
        aci.evaluate(adapter, 'full', rows=[invalid])
    assert missing.value.result['skipped'] == 1
    assert 'aci_score' not in missing.value.result
    with pytest.raises(aci.NoValidItems) as empty:
        aci.evaluate(adapter, 'full', rows=[])
    assert empty.value.result['attempted'] == 0


def test_smoke_selection_is_reproducible_and_full_visits_every_item():
    with torch.random.fork_rng():
        torch.manual_seed(19)
        model = TinyTransformer(width=4, layers=1, heads=1, context_length=8).eval()
    adapter = SimpleNamespace(model=model, context_length=8)
    rows = [sample(str(index)) for index in range(12)]
    smoke = aci.evaluate(adapter, 'smoke', rows=rows)
    repeated = aci.evaluate(adapter, 'smoke', rows=rows)
    full = aci.evaluate(adapter, 'full', rows=rows)
    assert smoke['samples'] == smoke['attempted'] == 10
    assert smoke['sample_digest'] == repeated['sample_digest']
    assert smoke['aci_score'] == repeated['aci_score']
    assert full['samples'] == full['attempted'] == 12
    assert [item['id'] for item in full['items']] == [item['id'] for item in rows]
    assert full['aci_score'] == pytest.approx((full['priority_score'] + full['linkage_score']) / 2)
