import json
from types import SimpleNamespace

import pytest

from fabryka_track import leaderboard_suite as suite
from fabryka_track.benchmark_agent import gpu_ready


def test_int_index_matches_published_reference_and_requires_complete_inputs():
    values={'arc_easy':.5101,'arc_challenge':.2713,'piqa':.6676,'hellaswag':.3983,'arithmark3':.389}
    results={k:{'acc_norm':v} for k,v in values.items()}
    assert suite.intelligence_index(results)==pytest.approx(23.041095890410958)
    assert suite.intelligence_index({}) is None
    del results['arc_challenge']
    assert suite.intelligence_index(results) is None
    assert suite.intelligence_index({k:{'acc_norm':0} for k in values})<0


def test_elo_matches_pinned_official_runner_fixture():
    # Reference output of estimate_elo from d4aade51312889e8580963e1ce960c6eaef1a450.
    games=[(1,750,True),(1.5,900,False),(3.15,1200,True),(1.4,1050,False)]
    assert suite.fixed_item_elo(games)==pytest.approx(1073.3874441008725,abs=1e-9)
    assert suite.fixed_item_elo([])==pytest.approx(1000)


def test_continuation_metrics_keep_raw_and_normalized_decisions_separate():
    # The longer option has worse summed likelihood but better likelihood per byte.
    model=SimpleNamespace(score_many=lambda pairs:[(-2.,False),(-3.,False)])
    row={'ctx':'Question:','endings':[' a',' abbbbb'],'label':'1'}
    result=suite.evaluate('arithmark2',model,'full',rows=[row])
    assert result['accuracy']==0 and result['acc_norm']==1
    assert result['samples']==1 and len(result['sample_digest'])==64
    banana={'context':'Question:','continuations':row['endings'],'label':1,
            'category_weight':1.4,'difficulty_weight':2.25,'item_elo':1200}
    result=suite.evaluate('bananamind_base_1_1',model,'full',rows=[banana])
    assert result['elo']==suite.fixed_item_elo([(3.15,1200,True)])


def test_dataset_checksum_rejected_before_scoring(tmp_path,monkeypatch):
    (tmp_path/'arithmark2.jsonl').write_text(json.dumps({'fake':'data'}))
    monkeypatch.setenv('TRACK_BENCHMARK_DATA_DIR',str(tmp_path))
    with pytest.raises(ValueError,match='checksum'):suite.load_rows('arithmark2')


def test_idle_guard_blocks_busy_low_memory_and_unreadable_gpu(monkeypatch):
    import subprocess
    monkeypatch.setenv('TRACK_BENCHMARK_REQUIRE_IDLE','1')
    monkeypatch.setenv('TRACK_BENCHMARK_MIN_FREE_MB','10000')
    for output,expected in [('100, 18000',False),('0, 8000',False),('0, 23000',True),('N/A, 23000',False)]:
        monkeypatch.setattr(subprocess,'check_output',lambda *a,**kw:output)
        assert gpu_ready() is expected
    monkeypatch.setattr(subprocess,'check_output',lambda *a,**kw:(_ for _ in []).throw(OSError('no GPU')))
    assert not gpu_ready()


def test_campaign_is_idempotent_targets_simp_and_respects_visibility(client):
    from test_benchmarks import finished,launch
    from fabryka_track.benchmark_campaign import plan,enqueue
    from fabryka_track.database import SessionLocal
    from fabryka_track.models import Run,BenchmarkEvaluation
    run=finished(client,launch(client).json()['id'])
    with SessionLocal() as db:
        manifest=plan(db,'test-campaign','simp')
        assert [row['run_id'] for row in manifest['models']]==[run['id']]
        assert enqueue(db,manifest)==1
        assert enqueue(db,manifest)==0
        row=db.get(BenchmarkEvaluation,manifest['models'][0]['evaluation_id'])
        assert row.provenance['target_runner']=='simp' and row.tasks==suite.TASKS
        assert row.provenance['dataset_revisions']==suite.REVISIONS
        db.get(Run,run['id']).is_public=False;db.commit()
        assert plan(db,'test-campaign','simp')['models']==[]
    assert client.get('/api/benchmark-results/campaign-status').json()['total']==0
