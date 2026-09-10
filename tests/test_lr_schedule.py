import pytest
from fabryka_track.lr_schedule import learning_rate_at


def test_trapezoidal_boundaries_and_constant_compatibility():
    cfg={'steps':2000,'learning_rate':.001,'lr_schedule':'trapezoidal'}
    assert learning_rate_at(cfg,1)==pytest.approx(.001/100)
    assert learning_rate_at(cfg,100)==pytest.approx(.001)
    assert learning_rate_at(cfg,1000)==pytest.approx(.001)
    assert learning_rate_at(cfg,1500)==pytest.approx(.001*.525)
    assert learning_rate_at(cfg,2000)==pytest.approx(.001*.05)
    assert learning_rate_at({'steps':20,'learning_rate':.003},20)==.003
