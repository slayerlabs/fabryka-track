from types import SimpleNamespace, MethodType
import pytest
import torch
pytest.importorskip('lm_eval')
from fabryka_track.benchmark_model import ByteCheckpointLM


def test_oom_retries_smaller_chunks_without_double_counting():
    calls=[]
    def score(chunk):
        calls.append(len(chunk))
        if len(chunk)>2:raise torch.OutOfMemoryError('simulated')
        return [-1.0]*len(chunk),[True]*len(chunk)
    model=SimpleNamespace(context_length=4,total_requests=0,truncated_requests=0,
                          _device=torch.device('cpu'),_score_chunk=score)
    model._batches=MethodType(ByteCheckpointLM._batches,model)
    result=ByteCheckpointLM.score_many(model,[('abcde','abcdefgh')],batch_size=8)
    assert result==[(-8.0,True)]
    assert calls[:3]==[8,4,2]
    assert model.total_requests==1
