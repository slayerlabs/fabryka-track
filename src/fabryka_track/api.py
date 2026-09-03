import mimetypes
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import create_tables, session_scope
from .models import Artifact, IngestedEvent, Metric, Project, Run, RunLog
from .schemas import EventBatch, LogInput, Notes
from .settings import settings

@asynccontextmanager
async def lifespan(_app: FastAPI):
    create_tables()
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Fabryka Track", version="0.1.0", lifespan=lifespan)


def db():
    yield from session_scope()


def serialize_run(run: Run, latest: dict | None = None):
    return {
        "id": run.id, "project": run.project.name, "name": run.name, "state": run.state,
        "config": run.config, "metadata": run.metadata_, "note": run.note,
        "conclusion": run.conclusion, "started_at": run.started_at, "ended_at": run.ended_at,
        "latest_metrics": latest or {},
    }


@app.get("/api/projects")
def projects(session: Session = Depends(db)):
    return [{"id": p.id, "name": p.name} for p in session.scalars(select(Project).order_by(Project.name))]


@app.get("/api/projects/{name}/runs")
def runs(name: str, state: str | None = None, search: str | None = None,
         sort: str = Query("started_at", pattern="^(started_at|name|state)$"), session: Session = Depends(db)):
    project = session.scalar(select(Project).where(Project.name == name))
    if not project:
        raise HTTPException(404, "Project not found")
    query = select(Run).where(Run.project_id == project.id)
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
        result.append(serialize_run(item, latest))
    return result


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str, session: Session = Depends(db)):
    item = session.get(Run, run_id)
    if not item:
        raise HTTPException(404, "Run not found")
    metrics = session.execute(select(Metric.key, Metric.step, Metric.timestamp, Metric.value).where(Metric.run_id == run_id).order_by(Metric.step, Metric.id)).all()
    series: dict[str, list] = {}
    for key, step, timestamp, value in metrics:
        series.setdefault(key, []).append({"step": step, "timestamp": timestamp, "value": value})
    logs = session.scalars(select(RunLog).where(RunLog.run_id == run_id).order_by(RunLog.timestamp)).all()
    artifacts = session.scalars(select(Artifact).where(Artifact.run_id == run_id)).all()
    data = serialize_run(item)
    data.update(metrics=series, logs=[{"timestamp": x.timestamp, "level": x.level, "message": x.message} for x in logs],
                artifacts=[{"id": x.id, "name": x.name, "size": x.size} for x in artifacts])
    return data


@app.get("/api/compare")
def compare(ids: list[str] = Query(), session: Session = Depends(db)):
    if not 2 <= len(ids) <= 10:
        raise HTTPException(400, "Choose between 2 and 10 runs")
    return [run_detail(run_id, session) for run_id in ids]


@app.patch("/api/runs/{run_id}/notes")
def update_notes(run_id: str, body: Notes, session: Session = Depends(db)):
    item = session.get(Run, run_id)
    if not item:
        raise HTTPException(404, "Run not found")
    item.note, item.conclusion = body.note, body.conclusion
    session.commit()
    return serialize_run(item)


@app.post("/api/runs/{run_id}/logs")
def add_log(run_id: str, body: LogInput, session: Session = Depends(db)):
    if not session.get(Run, run_id):
        raise HTTPException(404, "Run not found")
    session.add(RunLog(run_id=run_id, level=body.level, message=body.message))
    session.commit()
    return {"ok": True}


@app.post("/api/events")
def ingest(batch: EventBatch, session: Session = Depends(db)):
    accepted = []
    for event in batch.events:
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
                session.add(Run(id=payload["run_id"], project_id=project.id, name=payload["name"],
                                config=payload.get("config", {}), metadata_=payload.get("metadata", {}),
                                note=payload.get("note", ""), started_at=event.timestamp))
        elif event.type == "run.metrics":
            if not session.get(Run, payload["run_id"]):
                raise HTTPException(409, f"Unknown run {payload['run_id']}")
            for key, value in payload["metrics"].items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    session.add(Metric(run_id=payload["run_id"], key=key, step=payload["step"], timestamp=event.timestamp, value=float(value)))
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
async def upload_artifact(run_id: str, file: UploadFile = File(...), session: Session = Depends(db)):
    if not session.get(Run, run_id):
        raise HTTPException(404, "Run not found")
    content = await file.read()
    safe_name = Path(file.filename or "artifact").name
    storage_key = f"{run_id}/{safe_name}"
    if settings.r2_endpoint and settings.r2_bucket:
        import boto3
        client = boto3.client("s3", endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key, aws_secret_access_key=settings.r2_secret_key)
        client.put_object(Bucket=settings.r2_bucket, Key=storage_key, Body=content,
                          ContentType=file.content_type or "application/octet-stream")
    else:
        target = settings.artifact_dir / run_id / safe_name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    artifact = Artifact(run_id=run_id, name=safe_name, storage_key=storage_key, size=len(content))
    session.add(artifact); session.commit()
    return {"id": artifact.id, "name": safe_name, "size": len(content)}


@app.get("/api/artifacts/{artifact_id}")
def download_artifact(artifact_id: str, session: Session = Depends(db)):
    artifact = session.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(404, "Artifact not found")
    if settings.r2_endpoint and settings.r2_bucket:
        import boto3
        client = boto3.client("s3", endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key, aws_secret_access_key=settings.r2_secret_key)
        return {"url": client.generate_presigned_url("get_object", Params={"Bucket": settings.r2_bucket, "Key": artifact.storage_key}, ExpiresIn=900)}
    path = settings.artifact_dir / artifact.storage_key
    return FileResponse(path, filename=artifact.name, media_type=mimetypes.guess_type(artifact.name)[0])


@app.get("/health")
def health(session: Session = Depends(db)):
    session.scalar(select(func.count()).select_from(Project))
    return {"status": "ok", "time": datetime.now(timezone.utc)}


@app.get("/{path:path}", response_class=HTMLResponse)
def web(path: str = ""):
    return HTMLResponse((Path(__file__).parent / "static" / "index.html").read_text())
