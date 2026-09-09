from conftest import sign_in
import torch
from fabryka_track.generation_worker import sample
from fabryka_track.native_model import TinyTransformer
from test_training import finished, launch

def test_samples_are_actual_checkpoint_outputs_and_reproducible(tmp_path):
    cfg=dict(width=8,layers=1,heads=2,context_length=8)
    model=TinyTransformer(**cfg)
    with torch.no_grad():
        for p in model.parameters():p.zero_()
        model.norm.bias.fill_(1)
        model.head.weight[65].fill_(1)
    path=tmp_path/'model.pt'
    torch.save(dict(config=cfg,state_dict=model.state_dict(),best_step=7),path)
    options=dict(prompt='long prompt here',max_new_bytes=4,temperature=0,top_k=40,seed=42)
    result=sample(path,options)
    assert result['continuation']=='AAAA'
    assert result['prompt_truncated'] and result['checkpoint_step']==7
    assert len(result['checkpoint_sha256'])==64
    options['temperature']=.8
    assert sample(path,options)['raw_bytes_hex']==sample(path,options)['raw_bytes_hex']

def test_generation_permissions_limits_and_busy_slot(client,monkeypatch):
    from fabryka_track import generation
    run=finished(client,launch(client).json()['id'])
    url='/api/runs/'+run['id']+'/generate'
    assert client.post(url,json={'prompt':'hello','max_new_bytes':513}).status_code==422
    generation._slot.acquire()
    try:assert client.post(url,json={'prompt':'hello'}).status_code==429
    finally:generation._slot.release()
    client.post('/api/auth/logout')
    assert client.post(url,json={'prompt':'hello'}).status_code==401
    sign_in(client, 'other')
    assert client.post(url,json={'prompt':'hello'}).status_code==404
