from datetime import datetime, timezone
from uuid import uuid4

import pytest


def event(kind, payload, event_id=None):
    return {"id": event_id or str(uuid4()), "type": kind,
            "timestamp": datetime.now(timezone.utc).isoformat(), "payload": payload}


def test_run_lifecycle_compare_and_notes(client):
    run_ids = [str(uuid4()), str(uuid4())]
    events = []
    for i, run_id in enumerate(run_ids):
        events += [
            event("run.init", {"run_id": run_id, "project": "qwen", "name": f"replay-{i}",
                               "config": {"lr": 3e-5, "replay": i * 10}, "metadata": {"gpu_count": 2}}),
            event("run.metrics", {"run_id": run_id, "step": 1,
                                  "metrics": {"train/loss": 1.9 - i / 10, "text": "ignored"}}),
            event("run.finish", {"run_id": run_id, "state": "finished"}),
        ]
    response = client.post("/api/events", json={"events": events})
    assert response.status_code == 200
    listed = client.get("/api/projects/qwen/runs").json()
    assert len(listed) == 2
    assert listed[0]["latest_metrics"]["train/loss"] == pytest.approx(1.8)
    compared = client.get("/api/compare", params=[("ids", x) for x in run_ids])
    assert compared.status_code == 200
    assert len(compared.json()) == 2
    notes = client.patch(f"/api/runs/{run_ids[0]}/notes", json={"note": "why", "conclusion": "better"})
    assert notes.json()["conclusion"] == "better"


def test_event_ingestion_is_idempotent(client):
    run_id, metric_id = str(uuid4()), str(uuid4())
    init = event("run.init", {"run_id": run_id, "project": "p", "name": "r"})
    metric = event("run.metrics", {"run_id": run_id, "step": 0, "metrics": {"loss": 2}}, metric_id)
    assert client.post("/api/events", json={"events": [init, metric]}).status_code == 200
    assert client.post("/api/events", json={"events": [metric]}).status_code == 200
    detail = client.get(f"/api/runs/{run_id}").json()
    assert len(detail["metrics"]["loss"]) == 1


def test_artifact_and_health(client, tmp_path):
    run_id = str(uuid4())
    client.post("/api/events", json={"events": [event("run.init", {"run_id": run_id, "project": "p", "name": "r"})]})
    uploaded = client.post(f"/api/runs/{run_id}/artifacts", files={"file": ("result.txt", b"hello")})
    assert uploaded.status_code == 200
    downloaded = client.get(f"/api/artifacts/{uploaded.json()['id']}")
    assert downloaded.content == b"hello"
    assert client.get("/health").json()["status"] == "ok"
