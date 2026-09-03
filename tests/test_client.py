import json

from fabryka_track.client import RunClient


def test_offline_client_spools_without_raising(tmp_path):
    tracker = RunClient(api_url="http://127.0.0.1:1", spool_dir=tmp_path)
    tracker.init("project", "run", {"lr": 1e-3})
    tracker.log({"loss": 2.0}, step=0)
    tracker.log_text("still training")
    artifact = tmp_path / "checkpoint.bin"
    artifact.write_bytes(b"weights")
    tracker.artifact(artifact)
    tracker.finish(timeout=.1)
    events = [json.loads(x.read_text()) for x in tmp_path.glob("*.jsonl")]
    assert {x["type"] for x in events} == {"run.init", "run.metrics", "run.log", "run.artifact", "run.finish"}
    assert list((tmp_path / "artifacts").rglob("*.bin"))
