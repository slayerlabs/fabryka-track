import torch
from fabryka_track.qwen_model import Deep576_37L, apply_rope


def test_deep576_parameter_cap_and_weight_tying():
    model = Deep576_37L()
    assert model.parameter_count() == 149_863_232
    assert model.parameter_count() < 150_000_000
    assert model.lm_head.weight.data_ptr() == model.embed.weight.data_ptr()


def test_deep576_forward_shape():
    model = Deep576_37L().eval()
    with torch.no_grad(): output = model(torch.randint(0, model.vocab_size, (1, 3)))
    assert output.shape == (1, 3, model.vocab_size)


def test_rope_changes_later_positions_without_changing_shape():
    x = torch.ones(1, 1, 3, 4)
    rotated = apply_rope(x)
    assert rotated.shape == x.shape
    assert torch.equal(rotated[:, :, 0], x[:, :, 0])
    assert not torch.equal(rotated[:, :, 1], x[:, :, 1])
