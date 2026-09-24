import os
import mimetypes
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile, Request, Form
from fastapi.responses import RedirectResponse, FileResponse, HTMLResponse, JSONResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .accounts import router as accounts_router, require_user, current_user, owned_run
from .benchmarks import router as benchmarks_router, recover_evaluations, start_queue as start_benchmark_queue, stop_queue as stop_benchmark_queue
from .hf_publish import router as hf_publish_router, recover_uploads
from .huggingface_auth import router as huggingface_router
from .gpu_training import router as gpu_router, start_supervisor, stop_supervisor, status as gpu_status
from .database import create_tables, session_scope
from .models import AgentGoal, Artifact, BenchmarkEvaluation, Checkpoint, GoalEvent, GPUJob, IngestedEvent, Metric, Project, Run, RunLog, RunArtifactLink, RunAttribute
from .namespaces import router as namespace_router, set_attribute, append_series, checked_path
from .schemas import EventBatch, LogInput, Notes
from .settings import settings
from .training import router as training_router, start_worker, stop_worker
from .hf_datasets import router as hf_datasets_router, start_importer, stop_importer
from .goals import router as goals_router
from .research import router as research_router
from .agents import router as agents_router
from .external_training import router as external_training_router, PUBLIC_METRICS
from .dashboard import router as dashboard_router
from .white_benchmarks import router as white_router, start_worker as start_white, stop_worker as stop_white

@asynccontextmanager
async def lifespan(_app: FastAPI):
    create_tables()
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    start_worker()
    start_importer()
    recover_uploads()
    recover_evaluations()
    start_benchmark_queue()
    start_supervisor()
    start_white()
    try:
        yield
    finally:
        stop_white()
        stop_importer()
        stop_benchmark_queue()
        stop_supervisor()
        stop_worker()


app = FastAPI(title="Fabryka Track", version="0.1.0", lifespan=lifespan)


app.include_router(benchmarks_router)
app.include_router(hf_publish_router)
app.include_router(huggingface_router)
app.include_router(hf_datasets_router)
app.include_router(accounts_router)
app.include_router(training_router)
app.include_router(gpu_router)
app.include_router(namespace_router)
app.include_router(goals_router)
app.include_router(research_router)
app.include_router(agents_router)
app.include_router(external_training_router)
app.include_router(dashboard_router)
app.include_router(white_router)
from .generation import router as generation_router
app.include_router(generation_router)
from .benchmark_remote import router as benchmark_remote_router
app.include_router(benchmark_remote_router)
from .published_benchmarks import router as published_benchmarks_router
app.include_router(published_benchmarks_router)


@app.middleware("http")
async def browser_request_guard(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        # Non-simple header prevents form-based CSRF, including login CSRF.
        # No CORS policy grants another origin permission to send this header.
        bearer = request.headers.get("authorization", "").startswith("Bearer ")
        if not bearer and request.headers.get("x-track-request") != "1":
            return JSONResponse({"detail": "Reload the page and try again."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != str(request.base_url).rstrip("/"):
            return JSONResponse({"detail": "Cross-origin request denied."}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


def db():
    yield from session_scope()


def serialize_run(run: Run, latest: dict | None = None):
    return {
        "id": run.id, "is_public": run.is_public, "archived": run.archived, "project": run.project.name, "name": run.name, "state": run.state,
        "config": run.config, "metadata": run.metadata_, "note": run.note,
        "conclusion": run.conclusion, "started_at": run.started_at, "ended_at": run.ended_at,
        "latest_metrics": latest or {},
    }


@app.get("/api/projects")
def projects(session: Session = Depends(db), user=Depends(require_user)):
    return [{"id": p.id, "name": p.name} for p in session.scalars(select(Project).join(Run).where(Run.owner_id == user.id).distinct().order_by(Project.name))]


@app.get("/api/projects/{name}/runs")
def runs(name: str, state: str | None = None, search: str | None = None, archived: bool = False,
         sort: str = Query("started_at", pattern="^(started_at|name|state)$"), session: Session = Depends(db), user=Depends(require_user)):
    project = session.scalar(select(Project).where(Project.name == name))
    if not project:
        raise HTTPException(404, "Project not found")
    query = select(Run).where(Run.project_id == project.id, Run.owner_id == user.id, Run.archived == archived)
    if state:
        query = query.where(Run.state == state)
    if search:
        query = query.where(Run.name.ilike(f"%{search}%"))
    query = query.order_by(getattr(Run, sort).desc())
    result = []
    for item in session.scalars(query):
        rows = session.execute(select(Metric.key, Metric.value).where(Metric.run_id == item.id).order_by(Metric.step.desc(), Metric.id.desc())).all()
        latest = {}
        for key, value in rows:
            latest.setdefault(key, value)
        data=serialize_run(item, latest)
        data["gpu_status"]=gpu_status(session,item)
        result.append(data)
    return result


@app.get("/api/public/runs")
def public_runs(session: Session = Depends(db)):
    # Deliberately small projection: no private config, notes, logs or artifacts.
    return [{"id": run.id, "name": run.name, "state": run.state,
             "started_at": run.started_at, "ended_at": run.ended_at}
            for run in session.scalars(select(Run).where(Run.is_public.is_(True))
                                       .order_by(Run.started_at.desc(), Run.id))]


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str, session: Session = Depends(db), user=Depends(current_user)):
    item = session.get(Run, run_id)
    owner = bool(item and user and item.owner_id == user.id)
    if not owner and not (item and item.is_public):
        raise HTTPException(404 if user else 401, 'Run not found' if user else 'Sign in to view this run.')
    metrics = session.execute(select(Metric.key, Metric.step, Metric.timestamp, Metric.value).where(Metric.run_id == run_id).order_by(Metric.step, Metric.id)).all()
    series: dict[str, list] = {}
    for key, step, timestamp, value in metrics:
        series.setdefault(key, []).append({"step": step, "timestamp": timestamp, "value": value})
    if item.metadata_.get('engine') == 'external-training':
        token_steps = {p['step']: p['value'] for p in series.get('training/tokens_seen', [])}
        token_steps.update({p['step']: p['value'] for p in series.get('checkpoint/tokens', [])})
        for points in series.values():
            for point in points:
                # These source logs have no event timestamps. Do not turn import
                # receipt times into fabricated historical elapsed-time curves.
                point['timestamp'] = None
                point['tokens'] = token_steps.get(point['step'])
    if not owner:
        cfg = {k: item.config.get(k) for k in ('model', 'model_size', 'steps', 'batch_size', 'learning_rate', 'lr_schedule', 'seed',
               'compute', 'context_length', 'layers', 'width', 'heads', 'parameters', 'validation_split', 'early_stopping',
               'budget_mode', 'planned_training_tokens', 'tokens_per_parameter', 'token_unit',
               'tokenizer_vocab_size', 'optimizer', 'activation', 'kv_heads', 'classification')}
        cfg['mix'] = [{'name': d.get('name') if d.get('example') else 'Private dataset', 'weight': d.get('weight')}
                      for d in item.config.get('mix', [])]
        result = item.metadata_.get('training_result', {})
        result = {k: result.get(k) for k in ('best_step', 'best_val_loss', 'best_val_perplexity', 'completed_steps', 'tokens_seen', 'stop_reason')}
        return {'id': item.id, 'name': item.name, 'state': item.state, 'is_public': True, 'read_only': True,
                'started_at': item.started_at, 'ended_at': item.ended_at, 'config': cfg,
                'metadata': {'engine': item.metadata_.get('engine'), 'training_result': result,
                             **({'tracking': item.metadata_.get('tracking', {})} if item.metadata_.get('engine') == 'external-training' else {})},
                'parent_run_id': item.parent_run_id, 'forked_from_checkpoint_id': item.forked_from_checkpoint_id,
                'inherited_from': item.metadata_.get('inherited_from'),
                'note': '', 'conclusion': '', 'logs': [], 'artifacts': [],
                'metrics': {k: v for k, v in series.items() if k in ('train/loss', 'val/loss', 'val/perplexity',
                            'progress', 'training/tokens_seen', 'throughput/tokens_sec') or
                            (item.metadata_.get('engine') == 'external-training' and k in PUBLIC_METRICS)}}
    logs = session.scalars(select(RunLog).where(RunLog.run_id == run_id).order_by(RunLog.timestamp)).all()
    artifacts = session.scalars(select(Artifact).where(Artifact.run_id == run_id)).all()
    data = serialize_run(item)
    data["gpu_status"] = gpu_status(session,item)
    data.update(metrics=series, logs=[{"timestamp": x.timestamp, "level": x.level, "message": x.message} for x in logs],
                artifacts=[{"id": x.id, "name": x.name, "size": x.size} for x in artifacts],
                parent_run_id=item.parent_run_id, forked_from_checkpoint_id=item.forked_from_checkpoint_id,
                inherited_from=item.metadata_.get('inherited_from'))
    return data


@app.get("/api/compare")
def compare(ids: list[str] = Query(), session: Session = Depends(db), user=Depends(require_user)):
    if not 2 <= len(ids) <= 10:
        raise HTTPException(400, "Choose between 2 and 10 runs")
    return [run_detail(run_id, session, user) for run_id in ids]


@app.patch("/api/runs/{run_id}/notes")
def update_notes(run_id: str, body: Notes, session: Session = Depends(db), user=Depends(require_user)):
    item = owned_run(session, run_id, user)
    item.note, item.conclusion = body.note, body.conclusion
    session.commit()
    return serialize_run(item)


@app.post("/api/runs/{run_id}/logs")
def add_log(run_id: str, body: LogInput, session: Session = Depends(db), user=Depends(require_user)):
    owned_run(session, run_id, user)
    session.add(RunLog(run_id=run_id, level=body.level, message=body.message))
    session.commit()
    return {"ok": True}


@app.post("/api/runs/{run_id}/archive")
def archive_run(run_id: str, session: Session = Depends(db), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    run.archived = True
    session.commit()
    return {"ok": True, "id": run_id, "archived": True}


@app.post("/api/runs/{run_id}/unarchive")
def unarchive_run(run_id: str, session: Session = Depends(db), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    run.archived = False
    session.commit()
    return {"ok": True, "id": run_id, "archived": False}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str, session: Session = Depends(db), user=Depends(require_user)):
    owned_run(session, run_id, user)
    # Remove every row that references this run before the run itself so the
    # delete is clean on FK-enforcing backends (Postgres) too, not just SQLite.
    goal_ids = session.scalars(select(AgentGoal.id).where(AgentGoal.run_id == run_id)).all()
    if goal_ids:
        session.execute(delete(GoalEvent).where(GoalEvent.goal_id.in_(goal_ids)))
        session.execute(delete(AgentGoal).where(AgentGoal.run_id == run_id))
    # RunArtifactLink and Checkpoint reference artifacts.id -> drop them before Artifact.
    for model in (Metric, RunLog, RunAttribute, RunArtifactLink, Checkpoint, BenchmarkEvaluation, GPUJob):
        session.execute(delete(model).where(model.run_id == run_id))
    session.execute(delete(Artifact).where(Artifact.run_id == run_id))
    session.execute(delete(Run).where(Run.id == run_id))
    session.commit()
    return {"ok": True, "deleted": run_id}


@app.post("/api/events")
def ingest(batch: EventBatch, session: Session = Depends(db), user=Depends(require_user)):
    accepted = []
    for event in batch.events:
        existing = session.get(Run, event.payload.get("run_id"))
        if existing:
            owned_run(session, existing.id, user)
            if existing.metadata_.get("engine") == "tiny-transformer":
                raise HTTPException(409, "Studio metrics are managed by the training worker.")
        if session.get(IngestedEvent, event.id):
            accepted.append(event.id)
            continue
        payload = event.payload
        if event.type == "run.init":
            project = session.scalar(select(Project).where(Project.name == payload["project"]))
            if not project:
                project = Project(name=payload["project"])
                session.add(project)
                session.flush()
            if not session.get(Run, payload["run_id"]):
                session.add(Run(id=payload["run_id"], owner_id=user.id, project_id=project.id, name=payload["name"], is_public=True,
                                config=payload.get("config", {}), metadata_={**payload.get("metadata", {}), "engine": "sdk"},
                                note=payload.get("note", ""), started_at=event.timestamp))
        elif event.type == "run.metrics":
            if not session.get(Run, payload["run_id"]):
                raise HTTPException(409, f"Unknown run {payload['run_id']}")
            values={key:[[payload["step"],value]] for key,value in payload["metrics"].items() if isinstance(value,(int,float)) and not isinstance(value,bool)}
            if values:append_series(session,session.get(Run,payload["run_id"]),values,event.timestamp)
        elif event.type == "run.attribute":
            item=session.get(Run,payload["run_id"])
            if not item:raise HTTPException(409,"Unknown run")
            set_attribute(session,item,payload["path"],payload["value"])
        elif event.type == "run.finish":
            item = session.get(Run, payload["run_id"])
            if item:
                item.state = payload.get("state", "finished")
                item.ended_at = event.timestamp
        elif event.type == "run.log":
            if not session.get(Run, payload["run_id"]):
                raise HTTPException(409, f"Unknown run {payload['run_id']}")
            session.add(RunLog(run_id=payload["run_id"], timestamp=event.timestamp,
                               level=payload.get("level", "info"), message=payload["message"]))
        session.add(IngestedEvent(id=event.id))
        accepted.append(event.id)
    session.commit()
    return {"accepted": accepted}


@app.post("/api/runs/{run_id}/artifacts")
async def upload_artifact(run_id: str, file: UploadFile = File(...), namespace: str | None = Form(None), session: Session = Depends(db), user=Depends(require_user)):
    owned_run(session, run_id, user)
    if owned_run(session, run_id, user).metadata_.get("engine") == "tiny-transformer":
        raise HTTPException(409, "Studio artifacts are managed by the training worker.")
    if namespace:
        checked_path(namespace)
        if session.get(RunAttribute,(run_id,namespace)) or session.scalar(select(Metric.id).where(Metric.run_id==run_id,Metric.key==namespace).limit(1)):
            raise HTTPException(409,"This path already contains an attribute or series.")
    content = await file.read(20_000_001)
    if len(content) > 20_000_000:
        raise HTTPException(413, "Artifact exceeds 20 MB.")
    safe_name = Path(file.filename or "artifact").name
    storage_key = f"{run_id}/{uuid4()}/{safe_name}"
    if settings.r2_endpoint and settings.r2_bucket:
        import boto3
        client = boto3.client("s3", endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key, aws_secret_access_key=settings.r2_secret_key)
        client.put_object(Bucket=settings.r2_bucket, Key=storage_key, Body=content,
                          ContentType=file.content_type or "application/octet-stream")
    else:
        target = settings.artifact_dir / storage_key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    artifact = Artifact(run_id=run_id, name=safe_name, storage_key=storage_key, size=len(content))
    session.add(artifact); session.flush()
    if namespace:
        link=session.get(RunArtifactLink,(run_id,namespace))
        if link:link.artifact_id=artifact.id
        else:session.add(RunArtifactLink(run_id=run_id,path=namespace,artifact_id=artifact.id))
    session.commit()
    return {"id": artifact.id, "name": safe_name, "size": len(content)}


@app.get("/api/artifacts/{artifact_id}")
def download_artifact(artifact_id: str, session: Session = Depends(db), user=Depends(require_user)):
    artifact = session.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(404, "Artifact not found")
    owned_run(session, artifact.run_id, user)
    if not (settings.artifact_dir / artifact.storage_key).is_file() and settings.r2_endpoint and settings.r2_bucket:
        import boto3
        client = boto3.client("s3", endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key, aws_secret_access_key=settings.r2_secret_key)
        return {"url": client.generate_presigned_url("get_object", Params={"Bucket": settings.r2_bucket, "Key": artifact.storage_key}, ExpiresIn=900)}
    path = settings.artifact_dir / artifact.storage_key
    return FileResponse(path, filename=artifact.name, media_type=mimetypes.guess_type(artifact.name)[0])


@app.get("/health")
def health(session: Session = Depends(db)):
    session.scalar(select(func.count()).select_from(Project))
    return {"status": "ok", "time": datetime.now(timezone.utc), "release": os.environ.get("FABRYKA_DEPLOY_SHA")}


@app.get("/assets/{name}")
def static_asset(name: str):
    if name == "plotly-basic-3.1.0.min.js":
        return FileResponse(Path(__file__).parent / "static" / name, media_type="text/javascript")
    asset = Path(__file__).parent / "web" / "assets" / name
    if not asset.is_file():
        raise HTTPException(404, "Asset not found")
    return FileResponse(asset, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/goals/250m-english-base-model.md", include_in_schema=False)
def training_goal_document():
    return FileResponse(Path(__file__).parent / "static" / "goal-250m.md",
                        media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})


@app.get("/goal", include_in_schema=False)
def goal_rfc_page():
    return RedirectResponse("https://github.com/slayerlabs/rfcs/pull/5", status_code=307,
                            headers={"Cache-Control": "no-store"})


@app.get("/{path:path}", response_class=HTMLResponse)
def web(path: str = ""):
    pages = {"": "Serious experiment tracking", "overview": "Overview", "goals": "Goals / RFCs", "new": "Training studio", "runs": "Focused runs",
             "benchmarks": "Evaluation queue", "leaderboard": "Training results", "guide": "Learning guide",
             "login": "Sign in", "register": "Sign in", "account": "Account", "checkpoints": "Checkpoints",
             "status": "Goal status", "agents": "Agent sign up",
             "benchmark-results": "Published benchmarks",
             "goals/250m-english-base-model": "250M English base model"}
    path = path.rstrip("/")
    title = pages.get(path)
    if title is None:
        kind, _, identifiers = path.partition("/")
        try:
            if kind not in {"run", "compare"} or not identifiers:
                raise ValueError()
            from uuid import UUID
            for identifier in identifiers.split(","):
                UUID(identifier)
            if kind == "run" and "," in identifiers:
                raise ValueError()
        except ValueError:
            raise HTTPException(404, "Page not found")
        title = "Run dashboard" if kind == "run" else "Compare runs"
    entry = Path(__file__).parent / "web" / "index.html"
    if not entry.is_file():
        raise HTTPException(503, "Frontend build missing. Run npm ci && npm run build in frontend/.")
    content = entry.read_text()
    import re
    content = re.sub(r"<title>.*?</title>", f"<title>{title} · Fabryka Track</title>", content, count=1)
    return HTMLResponse(content, headers={"Cache-Control": "no-cache"})
