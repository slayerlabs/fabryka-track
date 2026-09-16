from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from conftest import sign_in
from fabryka_track.database import SessionLocal
from fabryka_track.models import Account, Artifact, BenchmarkEvaluation, Checkpoint, GPUJob, Metric, Project, Run, RunArtifactLink, RunAttribute, now
from fabryka_track.settings import settings
from fabryka_track.wikitext_suite import PROTOCOL as WIKITEXT_PROTOCOL


@pytest.fixture()
def dashboard_client(monkeypatch, request):
    # Seed GPU jobs without allowing the background provider supervisor to act.
    monkeypatch.setattr("fabryka_track.api.start_supervisor", lambda: None)
    return request.getfixturevalue("client")


def seed_project(session):
    owner = session.scalar(select(Account.id).where(Account.username == "tester"))
    project = Project(name="Dashboard experiments")
    session.add(project)
    session.flush()
    return owner, project.id


def add_run(session, owner, project_id, name, **values):
    run = Run(id=str(uuid4()), owner_id=owner, project_id=project_id, name=name,
              **{"state": "finished", "config": {}, "metadata_": {"engine": "tiny-transformer"}, **values})
    session.add(run)
    session.flush()
    return run


def add_checkpoint(session, run, step=10, *, artifact=None, is_best=False):
    checkpoint = Checkpoint(run_id=run.id, step=step, val_loss=0.5,
                            artifact_id=artifact.id if artifact else None, is_best=is_best)
    session.add(checkpoint)
    session.flush()
    return checkpoint


def test_dashboard_requires_owner_and_hides_foreign_lineage(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        hidden = add_run(session, "another-owner", project, "Hidden parent",
                         config={"experiment": "Unowned experiment"}, is_public=True)
        artifact = Artifact(run_id=hidden.id, name="model.pt", storage_key=f"{hidden.id}/model.pt", size=987)
        session.add(artifact)
        session.flush()
        source = add_checkpoint(session, hidden, artifact=artifact)
        own = add_run(session, owner, project, "Owned fork", parent_run_id=hidden.id,
                      forked_from_checkpoint_id=source.id,
                      config={"warm_start_checkpoint": {"storage_key": artifact.storage_key,
                                                        "checkpoint_id": source.id}})
        # Even a malformed cross-owner artifact link cannot disclose its metadata.
        own_checkpoint = add_checkpoint(session, own, artifact=artifact)
        session.add(Metric(run_id=hidden.id, key="val/loss", step=900, value=99))
        ids = own.id, own_checkpoint.id, hidden.id, source.id, artifact.id
        session.commit()
    response = dashboard_client.get("/api/dashboard")
    assert response.status_code == 200
    data = response.json()
    assert [run["id"] for run in data["runs"]] == [ids[0]]
    assert data["runs"][0]["parent_run_id"] is None
    assert data["runs"][0]["forked_from_checkpoint_id"] is None
    assert data["runs"][0]["experiment"] == "Owned fork"
    assert "warm_start_checkpoint" not in data["runs"][0]["config"]
    assert data["runs"][0]["latest_metrics"] == {}
    checkpoint = data["checkpoints"][0]
    assert checkpoint["id"] == ids[1]
    assert checkpoint["artifact_id"] is None
    assert checkpoint["size"] is None
    assert checkpoint["can_fork"] is False
    for hidden_id in ids[2:]:
        assert hidden_id not in response.text
    sign_in(dashboard_client, "empty-owner")
    assert dashboard_client.get("/api/dashboard").json()["runs"] == []
    dashboard_client.cookies.clear()
    assert dashboard_client.get("/api/dashboard").status_code == 401


def test_dashboard_orders_retried_metrics_and_bounds_history_with_endpoints(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        parent = add_run(session, owner, project, "Root run", config={"experiment": "Learning rates"})
        source = add_checkpoint(session, parent)
        child = add_run(session, owner, project, "Fork run", parent_run_id=parent.id,
                        forked_from_checkpoint_id=source.id, config={"steps": 2000})
        for step in range(121):
            session.add(Metric(run_id=child.id, key="val/loss", step=step, value=10 - step / 20))
        session.flush()
        session.add_all([
            Metric(run_id=child.id, key="val/loss", step=120, value=0.125),
            Metric(run_id=child.id, key="val/loss", step=0, value=12),
            Metric(run_id=child.id, key="train/loss", step=130, value=0.1),
        ])
        parent_id, child_id, source_id = parent.id, child.id, source.id
        session.commit()
    data = dashboard_client.get("/api/dashboard").json()
    runs = {run["id"]: run for run in data["runs"]}
    child = runs[child_id]
    assert child["parent_run_id"] == parent_id
    assert child["forked_from_checkpoint_id"] == source_id
    assert child["experiment"] == "Learning rates"
    assert child["latest_metrics"] == {"val/loss": 0.125, "train/loss": 0.1}
    assert child["step"] == 130
    assert runs[parent_id]["step"] is None
    history = child["val_loss_history"]
    assert len(history) == 40
    assert history[0] == {"step": 0, "value": 12}
    assert history[-1] == {"step": 120, "value": 0.125}
    assert [point["step"] for point in history] == sorted({point["step"] for point in history})


def test_gpu_hours_require_recorded_billing_not_cpu_or_wall_time(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        billing = {"pod_billing": {"source": "runpod_billing", "seconds": 7200}}
        cpu = add_run(session, owner, project, "CPU run", config={"compute": "cpu"},
                      metadata_=billing, started_at=now() - timedelta(hours=4), ended_at=now())
        gpu = add_run(session, owner, project, "Billed GPU", config={"compute": "runpod"}, metadata_=billing)
        unknown = add_run(session, owner, project, "Unbilled GPU", config={"compute": "runpod"},
                          started_at=now() - timedelta(hours=4), ended_at=now())
        ids = cpu.id, gpu.id, unknown.id
        session.commit()
    data = dashboard_client.get("/api/dashboard").json()
    runs = {run["id"]: run for run in data["runs"]}
    assert runs[ids[0]]["gpu_seconds"] is None
    assert runs[ids[1]]["gpu_seconds"] == 7200
    assert runs[ids[2]]["gpu_seconds"] is None
    assert data["gpu_memory"] == {"used_gb": None, "total_gb": None, "active_runs": 0}


def test_gpu_peaks_and_stale_heartbeats_are_not_live_memory(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        for index, (state, age, run_owner) in enumerate([
            ("running", 0, owner), ("running", 600, owner),
            ("finished", 0, owner), ("running", 0, "another-owner"),
        ]):
            run = add_run(session, run_owner, project, f"GPU worker {index}", state=state,
                          config={"compute": "runpod"})
            session.add(GPUJob(run_id=run.id, pod_id=f"pod-{index}", token_hash="unused",
                               state="running", heartbeat_at=now() - timedelta(seconds=age),
                               deadline=now() + timedelta(hours=1), bundle_sha256="unused"))
            session.add(Metric(run_id=run.id, key="gpu/peak_allocated_mb", step=10, value=8000))
        session.commit()
    data = dashboard_client.get("/api/dashboard").json()
    assert data["gpu_memory"] == {"used_gb": None, "total_gb": None, "active_runs": 1}


def test_checkpoint_storage_deduplicates_links_and_only_offers_loadable_forks(dashboard_client, monkeypatch):
    monkeypatch.setattr(settings, "r2_endpoint", "")
    monkeypatch.setattr(settings, "r2_bucket", "")
    with SessionLocal() as session:
        owner, project = seed_project(session)
        run = add_run(session, owner, project, "Checkpoint run")
        artifact = Artifact(run_id=run.id, name="checkpoint-10.pt", storage_key=f"{run.id}/checkpoint-10.pt", size=128)
        missing = Artifact(run_id=run.id, name="model.pt", storage_key=f"{run.id}/model.pt", size=256)
        session.add_all([artifact, missing])
        session.flush()
        path = settings.artifact_dir / artifact.storage_key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * 128)
        session.add_all([
            RunArtifactLink(run_id=run.id, path="checkpoints/latest", artifact_id=artifact.id),
            RunArtifactLink(run_id=run.id, path="checkpoints/best", artifact_id=artifact.id),
        ])
        available = add_checkpoint(session, run, artifact=artifact, is_best=True)
        unavailable = add_checkpoint(session, run, step=20, artifact=missing)
        external = add_run(session, owner, project, "External checkpoint", metadata_={"engine": "external-training"})
        external_checkpoint = add_checkpoint(session, external, artifact=artifact)
        ids = run.id, available.id, unavailable.id, external_checkpoint.id, artifact.id
        session.commit()
    data = dashboard_client.get("/api/dashboard").json()
    runs = {run["id"]: run for run in data["runs"]}
    checkpoints = {checkpoint["id"]: checkpoint for checkpoint in data["checkpoints"]}
    assert runs[ids[0]]["checkpoint_count"] == 2
    assert runs[ids[0]]["can_fork"] is True
    assert runs[ids[0]]["latest_checkpoint_id"] == ids[1]
    assert runs[ids[0]]["best_checkpoint_id"] == ids[1]
    assert checkpoints[ids[1]]["can_fork"] is True
    assert checkpoints[ids[1]]["size"] == 128
    assert checkpoints[ids[2]]["can_fork"] is False
    assert checkpoints[ids[3]]["can_fork"] is False
    # Namespace aliases must not multiply checkpoints or physical artifact bytes.
    sizes = {checkpoint["artifact_id"]: checkpoint["size"] for checkpoint in data["checkpoints"]}
    assert sizes[ids[4]] == 128
    assert sum(sizes.values()) == 384
    assert len(checkpoints) == 3


def test_focus_persists_for_whole_family_and_never_crosses_ownership(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        parent = add_run(session, owner, project, "Owned baseline")
        child = add_run(session, owner, project, "Owned fork", parent_run_id=parent.id)
        foreign = add_run(session, "another-owner", project, "Foreign fork", parent_run_id=parent.id)
        ids = parent.id, child.id, foreign.id
        session.commit()
    assert not any(run["focused"] for run in dashboard_client.get("/api/dashboard").json()["runs"])
    response = dashboard_client.patch(f"/api/runs/{ids[1]}/focus", json={"focused": True})
    assert response.status_code == 200
    assert response.json() == {"family_id": ids[0], "focused": True}
    runs = dashboard_client.get("/api/dashboard").json()["runs"]
    assert {run["id"] for run in runs if run["focused"]} == set(ids[:2])
    assert {run["family_id"] for run in runs} == {ids[0]}
    assert dashboard_client.patch(f"/api/runs/{ids[2]}/focus", json={"focused": True}).status_code == 404
    assert dashboard_client.patch(f"/api/runs/{ids[0]}/focus", json={"focused": False}).status_code == 200
    assert not any(run["focused"] for run in dashboard_client.get("/api/dashboard").json()["runs"])
    with SessionLocal() as session:
        assert session.get(RunAttribute, (ids[2], "workspace/focused")) is None


def test_running_forks_keep_entire_family_visible_and_block_archive(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        parent = add_run(session, owner, project, "Finished baseline")
        child = add_run(session, owner, project, "Active fork", state="running", parent_run_id=parent.id)
        unrelated = add_run(session, owner, project, "Archived experiment")
        ids = parent.id, child.id, unrelated.id
        session.add(Metric(run_id=child.id, key="progress", step=8, value=40))
        session.commit()
    runs = {run["id"]: run for run in dashboard_client.get("/api/dashboard").json()["runs"]}
    assert runs[ids[0]]["focused"] and runs[ids[1]]["focused"]
    assert not runs[ids[2]]["focused"]
    assert runs[ids[1]]["progress"] == 0.4
    assert dashboard_client.patch(f"/api/runs/{ids[0]}/focus", json={"focused": False}).status_code == 409


def test_dashboard_attaches_only_matching_checkpoint_evidence(dashboard_client):
    with SessionLocal() as session:
        owner, project = seed_project(session)
        run = add_run(session, owner, project, "Checkpoint evidence")
        artifact = Artifact(run_id=run.id, name="model.pt", storage_key=f"{run.id}/model.pt", size=123)
        session.add(artifact)
        session.flush()
        checkpoint = add_checkpoint(session, run, artifact=artifact)
        other = add_checkpoint(session, run, step=20)
        session.add(Metric(run_id=run.id, key="training/tokens_seen", step=10, value=10240))
        provenance = {"protocol": WIKITEXT_PROTOCOL, "checkpoint_id": checkpoint.id,
                      "artifact_id": artifact.id, "checkpoint_sha256": "a" * 64,
                      "dataset_split": "validation"}
        measurement = {"byte_perplexity": 2.1, "bits_per_byte": 1.070389,
                       "num_bytes": 50000, "num_documents": 20}
        for status, mode, split in [("finished", "full", "validation"),
                                    ("finished", "full", "test"),
                                    ("finished", "smoke", "validation"),
                                    ("failed", "full", "validation")]:
            session.add(BenchmarkEvaluation(run_id=run.id, status=status, mode=mode,
                tasks=["wikitext2"], results={"wikitext2": measurement},
                provenance={**provenance, "dataset_split": split}))
        session.add(BenchmarkEvaluation(run_id=run.id, status="finished", mode="full",
            tasks=["wikitext2"], results={"wikitext2": measurement},
            provenance={**provenance, "artifact_id": str(uuid4())}))
        incomplete = BenchmarkEvaluation(run_id=run.id, status="finished", mode="full",
            tasks=["wikitext2"], results={"wikitext2": {**measurement, "num_bytes": 0}},
            provenance=provenance)
        session.add(incomplete)
        session.flush()
        incomplete_id = incomplete.id
        ids = checkpoint.id, other.id
        session.commit()
    checkpoints = {row["id"]: row for row in dashboard_client.get("/api/dashboard").json()["checkpoints"]}
    assert checkpoints[ids[0]]["tokens_seen"] == 10240
    assert checkpoints[ids[1]]["tokens_seen"] is None
    assert checkpoints[ids[1]]["evaluations"] == []
    evidence = checkpoints[ids[0]]["evaluations"]
    assert {(row["status"], row["mode"], row["split"]) for row in evidence} == {
        ("finished", "full", "validation"), ("finished", "full", "test"),
        ("finished", "smoke", "validation"), ("failed", "full", "validation")}
    assert next(row for row in evidence if row["id"] == incomplete_id)["byte_perplexity"] is None
    assert all(row["byte_perplexity"] == (2.1 if row["status"] == "finished" else None)
               for row in evidence if row["id"] != incomplete_id)


def test_new_training_stays_focused_after_completion(dashboard_client):
    from test_training import launch, finished
    run = finished(dashboard_client, launch(dashboard_client, steps=10).json()["id"])
    assert run["state"] == "finished"
    rows = dashboard_client.get("/api/dashboard").json()["runs"]
    assert next(row for row in rows if row["id"] == run["id"])["focused"] is True
