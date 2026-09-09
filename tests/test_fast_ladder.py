import hashlib
import json
import math
from types import SimpleNamespace

import pytest
import torch
from fabryka_track.fast_ladder import COMPONENTS, PROTOCOL, evaluate, fast_score


def test_fast_score_requires_every_component_and_keeps_negative_values():
    assert sum(c['weight'] for c in COMPONENTS.values())==pytest.approx(1)
    results={k:{'normalized':0.5} for k in COMPONENTS}
    assert fast_score(results)==pytest.approx(.5)
    results['fast_lm']['normalized']=-1
    assert fast_score(results)==pytest.approx(-.1)
    del results['fast_arc']
    assert fast_score(results) is None


def test_lm_uniform_byte_model_scores_each_byte_once_and_verifies_pack(tmp_path,monkeypatch):
    raw=(json.dumps({'text':'ąbcd'*20})+'\n').encode()
    (tmp_path/'fast_lm.jsonl').write_bytes(raw)
    manifest={'protocol':PROTOCOL,'components':{'fast_lm':{'sha256':hashlib.sha256(raw).hexdigest()}},'sources':{'fast_lm':{}}}
    (tmp_path/'manifest.json').write_text(json.dumps(manifest))
    monkeypatch.setenv('TRACK_FAST_LADDER_DIR',str(tmp_path))
    model=SimpleNamespace(context_length=7,_device=torch.device('cpu'),model=lambda x:torch.zeros((*x.shape,256)))
    result=evaluate('fast_lm',model,'full')
    assert result['samples']==100
    assert result['bpb']==pytest.approx(8)
    assert result['normalized']==pytest.approx(0,abs=1e-6)
    (tmp_path/'fast_lm.jsonl').write_text('{}')
    with pytest.raises(ValueError,match='checksum'):evaluate('fast_lm',model,'full')
