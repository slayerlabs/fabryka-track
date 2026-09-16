"""Owner-only dashboard projections, without downloading run histories or artifacts."""
import math
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Integer, and_, case, cast, func, select
from sqlalchemy.orm import Session

from .accounts import require_user, owned_run
from .database import session_scope
from .models import Artifact, BenchmarkEvaluation, Checkpoint, GPUJob, Metric, Project, Run, RunAttribute
from .settings import settings
from .gpu_costs import cost_summary
from .wikitext_suite import PROTOCOL as WIKITEXT_PROTOCOL

router = APIRouter(prefix="/api")
SPARKLINE_POINTS = 40
HEARTBEAT_MAX_AGE = timedelta(minutes=2)
CHECKPOINT_NAME = re.compile(r"(?:model|checkpoint-\d+)\.pt")
FOCUS_PATH = "workspace/focused"
ACTIVE_STATES = ("queued", "running", "stopping")


def _number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def _utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _history(session, owned_ids):
    # Deduplicate retries before sampling. All ranking stays in SQL, so even a
    # million-step run transfers at most SPARKLINE_POINTS validation samples.
    deduplicated = select(
        Metric.run_id, Metric.step, Metric.value,
        func.row_number().over(
            partition_by=(Metric.run_id, Metric.step), order_by=Metric.id.desc()
        ).label("version"),
    ).where(Metric.run_id.in_(owned_ids), Metric.key == "val/loss").subquery()
    positions = select(
        deduplicated.c.run_id, deduplicated.c.step, deduplicated.c.value,
        func.row_number().over(
            partition_by=deduplicated.c.run_id, order_by=deduplicated.c.step
        ).label("position"),
        func.count().over(partition_by=deduplicated.c.run_id).label("total"),
    ).where(deduplicated.c.version == 1).subquery()
    bucket = case(
        (positions.c.total <= SPARKLINE_POINTS, positions.c.position),
        else_=cast(
            (positions.c.position - 1) * (SPARKLINE_POINTS - 1)
            / func.nullif(positions.c.total - 1, 0), Integer,
        ),
    )
    sampled = select(
        positions.c.run_id, positions.c.step, positions.c.value,
        func.row_number().over(
            partition_by=(positions.c.run_id, bucket), order_by=positions.c.step
        ).label("sample"),
    ).subquery()
    result = {}
    for run_id, step, value in session.execute(
        select(sampled.c.run_id, sampled.c.step, sampled.c.value)
        .where(sampled.c.sample == 1).order_by(sampled.c.run_id, sampled.c.step)
    ):
        if _number(value) is not None:
            result.setdefault(run_id, []).append({"step": step, "value": value})
    return result


def _available_checkpoint(artifact):
    if not artifact or artifact.size <= 0 or not CHECKPOINT_NAME.fullmatch(artifact.name):
        return False
    # Both CPU and RunPod warm-start loaders currently require a local file.
    # R2 configuration alone cannot prove an object exists or make it loadable.
    root = settings.artifact_dir.resolve()
    path = (root / artifact.storage_key).resolve()
    return path.is_relative_to(root) and path.is_file()


def _experiments(runs, projects):
    experiments = {}
    for run in runs.values():
        current, path, seen = run, [], set()
        while current.id not in experiments and current.id not in seen:
            path.append(current.id)
            seen.add(current.id)
            experiment = current.config.get("experiment")
            if isinstance(experiment, str) and experiment.strip():
                experiments[current.id] = experiment.strip()
                break
            parent = runs.get(current.parent_run_id)
            if parent is None:
                experiments[current.id] = current.name or projects[current.id]
                break
            current = parent
        experiment = experiments.get(current.id, current.name or projects[current.id])
        for run_id in path:
            experiments[run_id] = experiment
    return experiments


def _families(runs):
    """Resolve only visible ancestors; malformed cycles get one stable identity."""
    families = {}
    for run_id in runs:
        current, path, positions = run_id, [], {}
        while current not in families and current not in positions:
            positions[current] = len(path)
            path.append(current)
            parent = runs[current].parent_run_id
            if parent not in runs:
                families[current] = current
                break
            current = parent
        family = families.get(current)
        if family is None:
            family = min(path[positions[current]:])
        for member in path:
            families[member] = family
    return families


class FocusInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    focused: bool


@router.patch("/runs/{run_id}/focus")
def focus(run_id: str, body: FocusInput, session: Session = Depends(session_scope),
          user=Depends(require_user)):
    owned_run(session, run_id, user)
    runs = {run.id: run for run in session.scalars(select(Run).where(Run.owner_id == user.id))}
    families = _families(runs)
    family_id = families[run_id]
    members = [run for run in runs.values() if families[run.id] == family_id]
    if not body.focused and any(run.state in ACTIVE_STATES for run in members):
        raise HTTPException(409, "Active experiment families stay in focus. Wait for training to finish before archiving.")
    attributes = {row.run_id: row for row in session.scalars(select(RunAttribute).where(
        RunAttribute.run_id.in_([run.id for run in members]), RunAttribute.path == FOCUS_PATH))}
    for run in members:
        attribute = attributes.get(run.id)
        if attribute:
            attribute.value = body.focused
        else:
            session.add(RunAttribute(run_id=run.id, path=FOCUS_PATH, value=body.focused))
    session.commit()
    return {"family_id": family_id, "focused": body.focused}


@router.get("/dashboard")
def dashboard(session: Session = Depends(session_scope), user=Depends(require_user)):
    rows = session.execute(
        select(Run, Project.name).join(Project, Run.project_id == Project.id)
        .where(Run.owner_id == user.id).order_by(Run.started_at.desc(), Run.id)
    ).all()
    runs = {run.id: run for run, _ in rows}
    memory = {"used_gb": None, "total_gb": None, "active_runs": 0}
    if not runs:
        return {"runs": [], "checkpoints": [], "gpu_memory": memory}
    owned_ids = select(Run.id).where(Run.owner_id == user.id)
    projects = {run.id: project for run, project in rows}
    experiments = _experiments(runs, projects)
    families = _families(runs)
    focused = {families[run.id] for run in runs.values() if run.state in ACTIVE_STATES}
    for attribute in session.scalars(select(RunAttribute).where(
        RunAttribute.run_id.in_(owned_ids), RunAttribute.path == FOCUS_PATH)):
        if attribute.value is True:
            focused.add(families[attribute.run_id])

    ranked = select(
        Metric.run_id, Metric.key, Metric.step, Metric.value,
        func.row_number().over(
            partition_by=(Metric.run_id, Metric.key),
            order_by=(Metric.step.desc(), Metric.id.desc()),
        ).label("position"),
    ).where(Metric.run_id.in_(owned_ids)).subquery()
    latest, steps = {}, {}
    for run_id, key, step, value in session.execute(
        select(ranked.c.run_id, ranked.c.key, ranked.c.step, ranked.c.value)
        .where(ranked.c.position == 1)
    ):
        steps[run_id] = max(steps.get(run_id, step), step)
        if _number(value) is not None:
            latest.setdefault(run_id, {})[key] = value
    history = _history(session, owned_ids)
    checkpoint_tokens = {}
    token_rows = session.execute(select(Metric.run_id, Metric.step, Metric.value)
        .join(Checkpoint, and_(Checkpoint.run_id == Metric.run_id, Checkpoint.step == Metric.step))
        .where(Metric.run_id.in_(owned_ids), Metric.key == "training/tokens_seen")
        .order_by(Metric.id.desc()))
    for run_id, step, value in token_rows:
        checkpoint_tokens.setdefault((run_id, step), _number(value))

    checkpoints, by_run, by_id, available = [], {}, {}, {}
    checkpoint_rows = session.execute(
        select(Checkpoint, Artifact)
        .outerjoin(Artifact, and_(
            Checkpoint.artifact_id == Artifact.id, Artifact.run_id.in_(owned_ids),
        ))
        .where(Checkpoint.run_id.in_(owned_ids))
        .order_by(Checkpoint.step.desc(), Checkpoint.created_at.desc(), Checkpoint.id)
    )
    for checkpoint, artifact in checkpoint_rows:
        run = runs[checkpoint.run_id]
        if artifact and artifact.id not in available:
            available[artifact.id] = _available_checkpoint(artifact)
        item = {
            "id": checkpoint.id, "run_id": run.id, "run_name": run.name,
            "step": checkpoint.step, "val_loss": _number(checkpoint.val_loss),
            "is_best": checkpoint.is_best, "created_at": _utc(checkpoint.created_at),
            "artifact_id": artifact.id if artifact else None,
            "size": artifact.size if artifact and artifact.size >= 0 else None,
            "can_fork": bool(run.metadata_.get("engine") == "tiny-transformer"
                             and artifact and available[artifact.id]),
            "tokens_seen": checkpoint_tokens.get((run.id, checkpoint.step)),
            "sha256": None, "evaluations": [],
        }
        checkpoints.append(item)
        by_run.setdefault(run.id, []).append(item)
        by_id[checkpoint.id] = item

    evaluations = session.scalars(select(BenchmarkEvaluation).where(
        BenchmarkEvaluation.run_id.in_(owned_ids),
        BenchmarkEvaluation.provenance["protocol"].as_string() == WIKITEXT_PROTOCOL)
        .order_by(BenchmarkEvaluation.created_at.desc(), BenchmarkEvaluation.id.desc()))
    for evaluation in evaluations:
        provenance = evaluation.provenance
        checkpoint = by_id.get(provenance.get("checkpoint_id"))
        split = provenance.get("dataset_split")
        digest = provenance.get("checkpoint_sha256")
        if (not checkpoint or checkpoint["run_id"] != evaluation.run_id
                or not checkpoint["artifact_id"]
                or checkpoint["artifact_id"] != provenance.get("artifact_id")
                or split not in ("validation", "test")
                or evaluation.mode not in ("smoke", "full")
                or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
            continue
        score = evaluation.results.get("wikitext2", {})
        score = score if isinstance(score, dict) else {}
        ppl = _number(score.get("byte_perplexity"))
        bpb = _number(score.get("bits_per_byte"))
        num_bytes = _number(score.get("num_bytes"))
        num_documents = _number(score.get("num_documents"))
        finished = (evaluation.status == "finished" and not score.get("error")
                    and ppl is not None and ppl > 0 and bpb is not None and bpb >= 0
                    and num_bytes is not None and num_bytes > 0 and num_bytes % 1 == 0
                    and num_documents is not None and num_documents > 0 and num_documents % 1 == 0)
        if checkpoint["sha256"] is None:
            checkpoint["sha256"] = digest
        checkpoint["evaluations"].append({
            "id": evaluation.id, "status": evaluation.status, "mode": evaluation.mode,
            "split": split, "protocol": WIKITEXT_PROTOCOL,
            "checkpoint_id": checkpoint["id"], "checkpoint_sha256": digest,
            "byte_perplexity": ppl if finished else None,
            "bits_per_byte": bpb if finished else None,
            "num_bytes": num_bytes if finished else None,
            "num_documents": num_documents if finished else None,
            "created_at": _utc(evaluation.created_at),
            "ended_at": _utc(evaluation.ended_at) if evaluation.ended_at else None,
            "error": evaluation.error,
        })

    jobs = {job.run_id: job for job in session.scalars(
        select(GPUJob).where(GPUJob.run_id.in_(list(runs)))
    )}
    now = datetime.now(timezone.utc)
    # The runner reports peak allocations, not current used/total GPU memory.
    # Never relabel those peaks (or finished-run samples) as live utilization.
    memory["active_runs"] = sum(
        bool(job.pod_id and not job.cleanup_done and job.state == "running"
             and runs[run_id].state in ("running", "stopping")
             and timedelta(0) <= now - _utc(job.heartbeat_at) <= HEARTBEAT_MAX_AGE)
        for run_id, job in jobs.items()
    )

    result = []
    for run in runs.values():
        run_checkpoints = by_run.get(run.id, [])
        usable = [checkpoint for checkpoint in run_checkpoints if checkpoint["can_fork"]]
        preferred = usable or run_checkpoints
        best = next((checkpoint for checkpoint in preferred if checkpoint["is_best"]), None)
        parent = runs.get(run.parent_run_id)
        source = by_id.get(run.forked_from_checkpoint_id)
        visible_source = bool(parent and source and source["run_id"] == parent.id)
        config = run.config
        if "warm_start_checkpoint" in config and not visible_source:
            # The embedded storage key also contains the hidden parent's ID.
            config = {key: value for key, value in config.items() if key != "warm_start_checkpoint"}
        billing = run.metadata_.get("pod_billing", {})
        gpu_seconds = None
        if run.config.get("compute") == "runpod" and billing.get("source") == "runpod_billing":
            seconds = _number(billing.get("seconds"))
            if seconds is not None and seconds >= 0:
                gpu_seconds = seconds
        job = jobs.get(run.id)
        metrics = latest.get(run.id, {})
        result.append({
            "id": run.id, "name": run.name, "project": projects[run.id],
            "experiment": experiments[run.id], "state": run.state,
            "family_id": families[run.id], "focused": families[run.id] in focused,
            "started_at": _utc(run.started_at),
            "ended_at": _utc(run.ended_at) if run.ended_at else None,
            "parent_run_id": parent.id if parent else None,
            "forked_from_checkpoint_id": source["id"] if visible_source else None,
            "config": config, "latest_metrics": latest.get(run.id, {}),
            "step": steps.get(run.id), "val_loss_history": history.get(run.id, []),
            "gpu_seconds": gpu_seconds, "checkpoint_count": len(run_checkpoints),
            "tokens_seen": metrics.get("training/tokens_seen"),
            "throughput": metrics.get("throughput/tokens_sec"),
            "progress": min(1.0, max(0.0, metrics["progress"] / 100)) if "progress" in metrics else None,
            "gpu_status": {
                "phase": job.state, "gpu": run.metadata_.get("gpu"),
                "cleanup_done": job.cleanup_done, "error": job.error,
                "hourly_usd": run.metadata_.get("hourly_usd"),
                "deadline": _utc(job.deadline) if job.deadline else None,
                "cost": cost_summary(job, run),
            } if job else None,
            "latest_checkpoint_id": preferred[0]["id"] if preferred else None,
            "best_checkpoint_id": best["id"] if best else None,
            "can_fork": bool(usable),
        })
    return {"runs": result, "checkpoints": checkpoints, "gpu_memory": memory}
