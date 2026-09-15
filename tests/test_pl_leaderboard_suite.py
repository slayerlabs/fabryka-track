from fabryka_track import leaderboard_suite as en
from fabryka_track import pl_leaderboard_suite as pl


def test_pl_tasks_are_the_pinned_polish_signal_set():
    assert pl.TASKS == ['pl_lm', 'pl_multiblimp', 'pl_induction', 'multiblimp_polish']
    assert pl.PROTOCOL == 'track-leaderboard-pl-v1'


def test_polish_board_is_disjoint_from_english_board():
    # Construct validity: Polish-first models are ranked on Polish tasks only,
    # never against the English continuation board (arc/piqa/hellaswag/...).
    assert set(pl.TASKS).isdisjoint(en.TASKS)
    assert pl.PROTOCOL != en.PROTOCOL


def test_pl_campaign_enqueues_polish_tasks_with_distinct_protocol(client):
    # A PL campaign must plan/enqueue the Polish tasks under the Polish protocol,
    # producing an evaluation distinct from the English board (different eid/protocol).
    from test_benchmarks import finished, launch
    from fabryka_track.benchmark_campaign import plan, enqueue
    from fabryka_track.database import SessionLocal
    from fabryka_track.models import BenchmarkEvaluation

    run = finished(client, launch(client).json()['id'])
    with SessionLocal() as db:
        manifest = plan(db, 'pl-campaign', 'simp', pl.TASKS, pl.PROTOCOL)
        assert manifest['protocol'] == pl.PROTOCOL
        assert [row['run_id'] for row in manifest['models']] == [run['id']]
        assert enqueue(db, manifest, pl.TASKS, pl.PROTOCOL, {}) == 1
        assert enqueue(db, manifest, pl.TASKS, pl.PROTOCOL, {}) == 0
        row = db.get(BenchmarkEvaluation, manifest['models'][0]['evaluation_id'])
        assert row.tasks == pl.TASKS
        assert row.provenance['protocol'] == pl.PROTOCOL
        assert row.provenance['dataset_revisions'] == {}
