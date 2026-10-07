"""Owner-triggered, asynchronous GLINT fast-proxy evaluations for White checkpoints."""
import json
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .accounts import owned_run, require_user, digest
from .database import session_scope
from .models import GlintProxyEvaluation, Metric, Run, RunAttribute

router = APIRouter(prefix="/api/runs")
PROTOCOL = "glint-fast-proxy-v1"
SCHEDULE_PATH = "benchmarks/glint_proxy/schedule"
ALLOWED_INTERVALS = {500, 1000, 2000, 5000}
CHECKPOINT_PREFIX = "checkpoints/"
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def compatible(run):
    return (run.metadata_.get("engine") == "sdk"
            and run.config.get("model") == "SlayerLab/Slayer149-balanced"
            and str(run.config.get("compute", "")).startswith("White:"))


def require_compatible(session, run_id, user):
    run = owned_run(session, run_id, user)
    if not compatible(run):
        raise HTTPException(409, "GLINT checkpoint evaluation is enabled for the Slayer149 White run only.")
    return run


def checkpoint_rows(session, run_id):
    rows = session.scalars(select(RunAttribute).where(
        RunAttribute.run_id == run_id, RunAttribute.path.startswith(CHECKPOINT_PREFIX)))
    found = []
    for row in rows:
        item = row.value
        if not isinstance(item, dict) or item.get("storage") != "White":
            continue
        try:
            step = int(item.get("step"))
        except (TypeError, ValueError):
            continue
        sha = item.get("sha256")
        if step >= 0 and isinstance(sha, str) and SHA256.fullmatch(sha):
            found.append({"step": step, "sha256": sha, "tokens": item.get("tokens"),
                          "bytes": item.get("bytes"), "updated_at": row.updated_at})
    return sorted(found, key=lambda item: item["step"])


def checkpoint_view(item):
    if not item:
        return None
    return {k: item.get(k) for k in ("step", "sha256", "tokens", "bytes")}


def serialize(row):
    score = (row.result or {}).get("estimated_overall_score")
    timing = (row.result or {}).get("timing") or {}
    return {"id": row.id, "checkpoint_step": row.checkpoint_step,
            "checkpoint_sha256": row.checkpoint_sha256, "source": row.source,
            "status": row.status, "score": score,
            "metrics": (row.result or {}).get("metrics", {}),
            "historical_heldout_mae": (row.result or {}).get("historical_heldout_mae"),
            "scoring_seconds": timing.get("scoring_seconds"),
            "device": timing.get("device"), "error": row.error,
            "created_at": row.created_at, "started_at": row.started_at,
            "ended_at": row.ended_at}


def new_evaluation(session, run, checkpoint, source):
    existing = session.scalar(select(GlintProxyEvaluation).where(
        GlintProxyEvaluation.run_id == run.id,
        GlintProxyEvaluation.checkpoint_step == checkpoint["step"]))
    if existing:
        if existing.status == "failed":
            existing.status = "queued"
            existing.error = None
            existing.result = {}
            existing.source = source
            existing.ended_at = None
            existing.worker_lease_hash = None
            existing.lease_until = None
        return existing, False
    row = GlintProxyEvaluation(run_id=run.id, checkpoint_step=checkpoint["step"],
                               checkpoint_sha256=checkpoint["sha256"], source=source,
                               status="queued", result={})
    session.add(row)
    session.flush()
    return row, True


class ScheduleInput(BaseModel):
    interval_steps: int | None = Field(default=None, ge=1, le=5000)


class LeaseInput(BaseModel):
    lease: str = Field(min_length=32, max_length=128)


class CompletionInput(BaseModel):
    lease: str = Field(min_length=32, max_length=128)
    result: dict | None = None
    error: str | None = Field(default=None, max_length=1000)


@router.get("/{run_id}/glint-proxy")
def history(run_id: str, session=Depends(session_scope), user=Depends(require_user)):
    run = require_compatible(session, run_id, user)
    latest = checkpoint_rows(session, run.id)
    schedule = session.get(RunAttribute, (run.id, SCHEDULE_PATH))
    rows = session.scalars(select(GlintProxyEvaluation).where(
        GlintProxyEvaluation.run_id == run.id).order_by(
        GlintProxyEvaluation.checkpoint_step.desc()).limit(100))
    return {"protocol": PROTOCOL, "latest_checkpoint": checkpoint_view(latest[-1] if latest else None),
            "schedule": schedule.value if schedule and isinstance(schedule.value, dict) else {"interval_steps": None, "next_step": None},
            "items": [serialize(row) for row in rows]}


@router.post("/{run_id}/glint-proxy/evaluate")
def evaluate_latest(run_id: str, session=Depends(session_scope), user=Depends(require_user)):
    run = require_compatible(session, run_id, user)
    checkpoints = checkpoint_rows(session, run.id)
    if not checkpoints:
        raise HTTPException(409, "No saved White checkpoint has synced to Track yet.")
    row, created = new_evaluation(session, run, checkpoints[-1], "manual")
    session.commit()
    return serialize(row) | {"created": created}


@router.post("/{run_id}/glint-proxy/schedule")
def schedule(run_id: str, body: ScheduleInput, session=Depends(session_scope), user=Depends(require_user)):
    run = require_compatible(session, run_id, user)
    if body.interval_steps is not None and body.interval_steps not in ALLOWED_INTERVALS:
        raise HTTPException(422, "Choose 500, 1,000, 2,000 or 5,000 steps, or disable the schedule.")
    latest = checkpoint_rows(session, run.id)
    interval = body.interval_steps
    value = {"protocol": PROTOCOL, "interval_steps": interval,
             "next_step": ((latest[-1]["step"] // interval) + 1) * interval if interval and latest else interval,
             "updated_at": datetime.now(timezone.utc).isoformat()}
    attribute = session.get(RunAttribute, (run.id, SCHEDULE_PATH))
    if attribute:
        attribute.value = value
        attribute.updated_at = datetime.now(timezone.utc)
    else:
        session.add(RunAttribute(run_id=run.id, path=SCHEDULE_PATH, value=value))
    session.commit()
    return value


@router.post("/{run_id}/glint-proxy/claim")
def claim(run_id: str, session=Depends(session_scope), user=Depends(require_user)):
    """Track sidecar polls this owner-scoped endpoint; no checkpoint is uploaded."""
    run = require_compatible(session, run_id, user)
    checkpoints = checkpoint_rows(session, run.id)
    schedule_attr = session.get(RunAttribute, (run.id, SCHEDULE_PATH))
    schedule_state = schedule_attr.value if schedule_attr and isinstance(schedule_attr.value, dict) else {}
    interval = schedule_state.get("interval_steps")
    next_step = schedule_state.get("next_step")
    if (isinstance(interval, int) and interval in ALLOWED_INTERVALS and isinstance(next_step, int)
            and checkpoints and checkpoints[-1]["step"] >= next_step):
        due = next((item for item in checkpoints if item["step"] >= next_step), checkpoints[-1])
        new_evaluation(session, run, due, "schedule")
        while next_step <= due["step"]:
            next_step += interval
        schedule_state = {**schedule_state, "next_step": next_step,
                          "last_queued_step": due["step"],
                          "updated_at": datetime.now(timezone.utc).isoformat()}
        schedule_attr.value = schedule_state
    now = datetime.now(timezone.utc)
    rows = list(session.scalars(select(GlintProxyEvaluation).where(
        GlintProxyEvaluation.run_id == run.id,
        GlintProxyEvaluation.status.in_(["queued", "running"])).order_by(
            GlintProxyEvaluation.created_at, GlintProxyEvaluation.id)))
    active = next((row for row in rows if row.status == "running" and row.lease_until and row.lease_until > now), None)
    if active:
        session.commit()
        return {"job": None}
    row = next((item for item in rows if item.status == "queued" or
                (item.status == "running" and (item.lease_until is None or item.lease_until <= now))), None)
    if not row:
        session.commit()
        return {"job": None}
    lease = secrets.token_urlsafe(32)
    row.status = "running"
    row.started_at = now
    row.ended_at = None
    row.worker_lease_hash = digest(lease)
    row.lease_until = now + timedelta(minutes=10)
    session.commit()
    return {"job": {"id": row.id, "checkpoint_step": row.checkpoint_step,
                     "checkpoint_sha256": row.checkpoint_sha256, "source": row.source,
                     "lease": lease}}


def leased_row(session, run_id, evaluation_id, lease, user):
    run = require_compatible(session, run_id, user)
    row = session.get(GlintProxyEvaluation, evaluation_id)
    if (not row or row.run_id != run.id or row.status != "running" or
            not row.worker_lease_hash or not secrets.compare_digest(row.worker_lease_hash, digest(lease))):
        raise HTTPException(409, "GLINT evaluation lease has expired or changed.")
    return row


@router.post("/{run_id}/glint-proxy/{evaluation_id}/heartbeat")
def heartbeat(run_id: str, evaluation_id: str, body: LeaseInput,
              session=Depends(session_scope), user=Depends(require_user)):
    row = leased_row(session, run_id, evaluation_id, body.lease, user)
    row.lease_until = datetime.now(timezone.utc) + timedelta(minutes=10)
    session.commit()
    return {"ok": True}


@router.post("/{run_id}/glint-proxy/{evaluation_id}/complete")
def complete(run_id: str, evaluation_id: str, body: CompletionInput,
             session=Depends(session_scope), user=Depends(require_user)):
    row = leased_row(session, run_id, evaluation_id, body.lease, user)
    now = datetime.now(timezone.utc)
    if body.error:
        row.status, row.error, row.ended_at = "failed", body.error, now
    else:
        result = body.result or {}
        identity = result.get("identity") or {}
        score = result.get("estimated_overall_score")
        if (result.get("kind") != "private development score estimate" or
                identity.get("checkpoint_sha256") != row.checkpoint_sha256 or
                result.get("checkpoint_step") != row.checkpoint_step or
                isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= 100):
            raise HTTPException(422, "Result does not match the requested checkpoint and proxy protocol.")
        try:
            encoded_result = json.dumps(result, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, "GLINT result must contain finite JSON values.") from exc
        if len(encoded_result) > 100_000:
            raise HTTPException(413, "GLINT result is too large.")
        row.status, row.error, row.result, row.ended_at = "finished", None, result, now
        metrics = {"glint_proxy/estimated_score": score}
        task_metrics = result.get("metrics") or {}
        for task, name in (("blimp", "accuracy_pct"), ("arc_easy", "accuracy_pct"), ("wikitext", "byte_perplexity")):
            value = (task_metrics.get(task) or {}).get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                metrics[f"glint_proxy/{task}_{name}"] = value
        seconds = (result.get("timing") or {}).get("scoring_seconds")
        if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
            metrics["glint_proxy/scoring_seconds"] = seconds
        session.add_all(Metric(run_id=row.run_id, key=key, step=row.checkpoint_step,
                               value=float(value), timestamp=now) for key, value in metrics.items())
    row.worker_lease_hash = None
    row.lease_until = None
    session.commit()
    return serialize(row)
