"""Owner-scoped goals and a fenced, pull-based engine protocol.

API processes never execute goal text. A connected worker executes one leased
goal. Expired goals block for human reconciliation rather than auto-replaying
possibly non-idempotent actions.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .accounts import digest, require_user, owned_run
from .database import session_scope
from .models import AgentGoal, GoalEngine, GoalEvent, Project, Run, RunLog, Metric

router = APIRouter(prefix="/api")
LEASE_SECONDS = 90
TERMINAL = {"completed", "failed", "cancelled"}


def now():
    return datetime.now(timezone.utc)


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value else None


def event(session, goal, message, kind="status", key=None):
    item = GoalEvent(goal_id=goal.id, event_key=key or str(uuid4()), kind=kind, message=message)
    session.add(item)
    session.add(RunLog(run_id=goal.run_id, level="info", message=message))
    return item


def sync_run(session, goal):
    run = session.get(Run, goal.run_id)
    run.state = {"completed": "finished", "failed": "failed", "cancelled": "cancelled"}.get(goal.state, "running")
    run.note = goal.summary
    if goal.state in TERMINAL:
        run.ended_at = now()
        run.conclusion = goal.summary


def expire(session, owner):
    rows = session.scalars(select(AgentGoal).where(AgentGoal.owner_id == owner,
        AgentGoal.state.in_(["running", "stopping"]), AgentGoal.lease_until < now())).all()
    for goal in rows:
        state = "cancelled" if goal.state == "stopping" else "blocked"
        message = ("Stop acknowledged by lease expiry. Check external jobs before starting more work."
                   if state == "cancelled" else "Engine connection lost. Inspect the workspace and external jobs before resuming.")
        changed = session.execute(update(AgentGoal).execution_options(synchronize_session=False).where(AgentGoal.id == goal.id,
            AgentGoal.state == goal.state, AgentGoal.lease_until < now()).values(
                state=state, summary=message, lease_hash=None, lease_until=None,
                active_owner=None if state == "cancelled" else owner, updated_at=now()))
        if changed.rowcount:
            session.refresh(goal)
            event(session, goal, message, "connection")
            sync_run(session, goal)
    session.commit()


def serialize(goal):
    return {key: utc(getattr(goal, key)) if key in {"created_at", "updated_at", "lease_until"} else getattr(goal, key) for key in ("id", "objective", "state", "summary", "run_id",
        "linked_runs", "created_at", "updated_at", "lease_until")}


def owned(session, goal_id, user):
    goal = session.get(AgentGoal, goal_id)
    if not goal or goal.owner_id != user.id:
        raise HTTPException(404, "Goal not found")
    return goal


class GoalInput(BaseModel):
    objective: str = Field(min_length=10, max_length=20000)


@router.post("/goals", status_code=201)
def create(body: GoalInput, user=Depends(require_user), session=Depends(session_scope)):
    objective = body.objective.strip()
    if len(objective) < 10:
        raise HTTPException(422, "Describe a goal in at least 10 characters.")
    expire(session, user.id)
    if session.scalar(select(AgentGoal.id).where(AgentGoal.active_owner == user.id)):
        raise HTTPException(409, "Finish or cancel your current goal before starting another.")
    try:
        project_name = "agent-goals-" + user.id
        project = session.scalar(select(Project).where(Project.name == project_name))
        if not project:
            project = Project(name=project_name)
            session.add(project)
            session.flush()
        run = Run(id=str(uuid4()), owner_id=user.id, is_public=False, project_id=project.id,
                  name="Goal: " + objective[:180], config={"engine": "goal-engine", "objective": objective},
                  metadata_={"engine": "goal-engine"})
        session.add(run)
        session.flush()
        goal = AgentGoal(owner_id=user.id, active_owner=user.id, objective=objective, run_id=run.id)
        session.add(goal)
        session.flush()
        event(session, goal, "Goal submitted. Waiting for a connected engine.", "created")
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "A goal was created concurrently. Reload to view it.")
    return serialize(goal)


@router.get("/goals")
def listing(user=Depends(require_user), session=Depends(session_scope)):
    expire(session, user.id)
    goals = session.scalars(select(AgentGoal).where(AgentGoal.owner_id == user.id)
                           .order_by(AgentGoal.created_at.desc()).limit(50)).all()
    engine = session.scalar(select(GoalEngine).where(GoalEngine.owner_id == user.id))
    return {"goals": [serialize(g) for g in goals], "active_id": next((g.id for g in goals if g.active_owner), None),
            "engine": {"name": engine.name, "runtime": engine.runtime, "heartbeat_at": utc(engine.heartbeat_at),
                       "online": bool(engine.heartbeat_at and utc(engine.heartbeat_at) > now()-timedelta(seconds=45))} if engine else None}


@router.get("/goals/{goal_id}")
def detail(goal_id: str, after: int = Query(0, ge=0), user=Depends(require_user), session=Depends(session_scope)):
    expire(session, user.id)
    goal = owned(session, goal_id, user)
    events = session.scalars(select(GoalEvent).where(GoalEvent.goal_id == goal.id, GoalEvent.id > after)
                            .order_by(GoalEvent.id).limit(200)).all()
    return {"goal": serialize(goal), "events": [{"id": e.id, "kind": e.kind, "message": e.message,
             "created_at": utc(e.created_at)} for e in events], "has_more": len(events) == 200}


class Control(BaseModel):
    action: Literal["stop", "resume"]
    message: str = Field(default="", max_length=5000)


@router.post("/goals/{goal_id}/control")
def control(goal_id: str, body: Control, user=Depends(require_user), session=Depends(session_scope)):
    expire(session, user.id)
    goal = owned(session, goal_id, user)
    old = goal.state
    if old in TERMINAL:
        raise HTTPException(409, "This goal has ended. Create a new goal.")
    if body.action == "resume":
        if old != "blocked":
            raise HTTPException(409, "Only a blocked goal can be resumed.")
        state, message = "queued", "Resume requested. " + body.message.strip()
    else:
        state = "stopping" if old in {"running", "stopping"} else "cancelled"
        message = "Stop requested. Waiting for the agent to exit." if state == "stopping" else "Goal cancelled."
    result = session.execute(update(AgentGoal).execution_options(synchronize_session=False).where(AgentGoal.id == goal.id, AgentGoal.state == old).values(
        state=state, summary=message, active_owner=None if state in TERMINAL else user.id, updated_at=now()))
    if not result.rowcount:
        session.rollback()
        raise HTTPException(409, "Goal changed. Reload and try again.")
    session.refresh(goal)
    event(session, goal, message, "user")
    sync_run(session, goal)
    session.commit()
    return serialize(goal)


class EngineInput(BaseModel):
    name: str = Field(default="My goal engine", min_length=1, max_length=100)


@router.post("/goal-engine/connect")
def connect(body: EngineInput, user=Depends(require_user), session=Depends(session_scope)):
    expire(session, user.id)
    if session.scalar(select(AgentGoal.id).where(AgentGoal.owner_id == user.id, AgentGoal.state.in_(["running", "stopping"]))):
        raise HTTPException(409, "Stop the running agent before replacing its credential.")
    engine = session.scalar(select(GoalEngine).where(GoalEngine.owner_id == user.id))
    token = "fte_" + secrets.token_urlsafe(40)
    if not engine:
        engine = GoalEngine(owner_id=user.id, token_hash=digest(token))
        session.add(engine)
    engine.token_hash, engine.name, engine.heartbeat_at = digest(token), body.name, None
    session.commit()
    return {"token": token, "engine_id": engine.id}


def worker(authorization: str = Header(default=""), session=Depends(session_scope)):
    token = authorization.removeprefix("Bearer ")
    engine = session.scalar(select(GoalEngine).where(GoalEngine.token_hash == digest(token))) if token.startswith("fte_") else None
    if not engine:
        raise HTTPException(401, "Invalid goal-engine credential")
    return engine


class Claim(BaseModel):
    runtime: str = Field(default="external", max_length=100)


@router.post("/goal-engine/claim")
def claim(body: Claim, engine=Depends(worker), session=Depends(session_scope)):
    expire(session, engine.owner_id)
    engine.heartbeat_at, engine.runtime = now(), body.runtime
    goal = session.scalar(select(AgentGoal).where(AgentGoal.active_owner == engine.owner_id, AgentGoal.state == "queued"))
    if not goal:
        session.commit()
        return {"goal": None}
    lease = secrets.token_urlsafe(40)
    result = session.execute(update(AgentGoal).execution_options(synchronize_session=False).where(AgentGoal.id == goal.id, AgentGoal.state == "queued").values(
        state="running", worker_id=engine.id, lease_hash=digest(lease), lease_until=now()+timedelta(seconds=LEASE_SECONDS),
        summary="Engine claimed the goal. Starting work.", updated_at=now()))
    if not result.rowcount:
        session.commit()
        return {"goal": None}
    session.refresh(goal)
    event(session, goal, goal.summary, "claimed")
    session.commit()
    history = session.scalars(select(GoalEvent).where(GoalEvent.goal_id == goal.id).order_by(GoalEvent.id.desc()).limit(40)).all()
    return {"goal": {**serialize(goal), "lease": lease, "context": [e.message for e in reversed(history)]}, "lease_seconds": LEASE_SECONDS}


class Progress(BaseModel):
    lease: str = Field(min_length=20, max_length=100)
    event_id: str = Field(min_length=1, max_length=100)
    state: Literal["running", "completed", "blocked", "failed", "cancelled"] = "running"
    message: str = Field(default="", max_length=8000)
    kind: Literal["status", "activity", "result"] = "status"
    run_ids: list[str] = Field(default_factory=list, max_length=30)


@router.post("/goal-engine/{goal_id}/progress")
def progress(goal_id: str, body: Progress, engine=Depends(worker), session=Depends(session_scope)):
    goal = session.get(AgentGoal, goal_id)
    if not goal or goal.owner_id != engine.owner_id or goal.worker_id != engine.id:
        raise HTTPException(409, "Assignment is not active")
    if not goal.lease_hash or not secrets.compare_digest(goal.lease_hash, digest(body.lease)):
        raise HTTPException(409, "Assignment is not active")
    # Idempotency includes a lost acknowledgement of a terminal event.
    if session.scalar(select(GoalEvent.id).where(GoalEvent.goal_id == goal.id, GoalEvent.event_key == body.event_id)):
        return {"state": goal.state, "stop": goal.state == "stopping", "ack": body.event_id}
    if goal.state not in {"running", "stopping"} or utc(goal.lease_until) <= now():
        raise HTTPException(409, "Assignment expired or ended")
    for run_id in body.run_ids:
        run = session.get(Run, run_id)
        if not run or run.owner_id != engine.owner_id:
            raise HTTPException(422, "Linked run must belong to the goal owner.")
    old = goal.state
    state = "cancelled" if old == "stopping" and body.state != "running" else (old if old == "stopping" else body.state)
    if state != "running" and old != "stopping" and not body.message.strip():
        raise HTTPException(422, "Explain why the agent ended or needs input.")
    message = body.message.strip()
    values = dict(state=state, updated_at=now(), lease_until=now()+timedelta(seconds=LEASE_SECONDS),
                  active_owner=None if state in TERMINAL else goal.owner_id,
                  linked_runs=list(dict.fromkeys(goal.linked_runs + body.run_ids)))
    if message and body.kind != "activity":
        values["summary"] = message
    if state == "cancelled":
        values["summary"] = "Agent stopped. " + message
    result = session.execute(update(AgentGoal).execution_options(synchronize_session=False).where(AgentGoal.id == goal.id, AgentGoal.state == old,
        AgentGoal.lease_hash == digest(body.lease), AgentGoal.lease_until > now()).values(**values))
    if not result.rowcount:
        session.rollback()
        raise HTTPException(409, "Assignment changed")
    session.refresh(goal)
    engine.heartbeat_at = now()
    if message:
        item = event(session, goal, message, body.kind, body.event_id)
        session.flush()
        session.add(Metric(run_id=goal.run_id, key="agent/updates", step=item.id, value=1))
    else:
        # Heartbeats do not bloat the timeline, but need no replayable side effects.
        pass
    sync_run(session, goal)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        return {"state": goal.state, "stop": goal.state == "stopping", "ack": body.event_id}
    return {"state": goal.state, "stop": goal.state == "stopping", "ack": body.event_id}
