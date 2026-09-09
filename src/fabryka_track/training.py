"""Small, real CPU training engine for the local single-process product."""
import copy
import hashlib
import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import torch
from torch import nn
from torch.nn import functional as F
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, model_validator
from typing import Literal
from sqlalchemy import select, or_
from sqlalchemy.orm import load_only

from .accounts import require_user, current_user, owned_run
from .database import SessionLocal, session_scope
from .models import Account, Artifact, Dataset, Metric, Project, Run, RunLog
from .settings import settings

router = APIRouter(prefix="/api")
executor = None
stopping = threading.Event()
launch_lock = threading.Lock()

EXAMPLES = {
    "Everyday English": "The morning light falls across the kitchen table. We open a book and read a story about a small town. A friend arrives with fresh bread. Outside, the rain has stopped and the garden smells of earth. We take the long road home, past the river and the old station. Learning takes patience, practice, and a little curiosity. Each day offers another chance to ask a better question. ",
    "Polish prose": "Poranne światło pada na drewniany stół. Otwieramy książkę i czytamy opowieść o małym mieście. Przyjaciel przynosi świeży chleb. Na zewnątrz przestało padać, a ogród pachnie ziemią. Wracamy dłuższą drogą, obok rzeki i starego dworca. Nauka wymaga cierpliwości, praktyki i odrobiny ciekawości. Każdy dzień daje nową okazję do zadawania lepszych pytań. ",
    "Python snippets": "def add(a, b):\n    return a + b\n\nfor item in items:\n    print(item)\n\nclass Counter:\n    def __init__(self):\n        self.value = 0\n    def increment(self):\n        self.value += 1\n\ndef average(values):\n    if not values:\n        return 0\n    return sum(values) / len(values)\n\nresult = [number * 2 for number in range(20)]\nprint(result)\n",
}


def start_worker():
    global executor
    stopping.clear()
    with SessionLocal() as session:
        for run in session.scalars(select(Run).where(Run.state.in_(["queued", "running", "stopping"]))):
            if run.metadata_.get("engine") == "tiny-transformer" and run.config.get("compute", "cpu") == "cpu":
                run.state = "interrupted"
                run.ended_at = datetime.now(timezone.utc)
                session.add(RunLog(run_id=run.id, message="Server stopped before training completed. Start a new run to retry."))
        for name, content in EXAMPLES.items():
            if not session.scalar(select(Dataset).where(Dataset.name == name, Dataset.example == True)):
                session.add(Dataset(name=name, content=content, example=True, sha256=hashlib.sha256(content.encode()).hexdigest()))
        session.commit()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="training")


def stop_worker():
    stopping.set()
    if executor:
        executor.shutdown(wait=True)


def describe(d):
    byte_count = d.byte_count if d.byte_count is not None else len(d.content.encode("utf-8"))
    return {"id": d.id, "name": d.name, "bytes": byte_count,
            "size_mb": byte_count / 1_000_000, "token_count": byte_count,
            "tokenizer": "utf8-bytes", "example": d.example, "sha256": d.sha256}


@router.get("/datasets/{dataset_id}/content", response_class=PlainTextResponse)
def dataset_content(dataset_id: str, session=Depends(session_scope), user=Depends(require_user)):
    """Stable UTF-8 source endpoint for a runner; verify the ETag before use."""
    dataset = session.get(Dataset, dataset_id)
    if not dataset or (not dataset.example and dataset.owner_id != user.id):
        raise HTTPException(404, "Dataset not found")
    return PlainTextResponse(dataset.content, headers={"ETag": f'"{dataset.sha256}"', "X-Dataset-SHA256": dataset.sha256})


def training_manifest(run):
    """Stable runner payload. A future GPU worker can consume this unchanged."""
    return {
        "schema_version": 1,
        "run_id": run.id,
        "run_name": run.name,
        "source": "scratch",
        "status": run.state,
        "runner": {"image": settings.runner_image},
        "model": {"name": run.config.get("model"), "size": run.config.get("model_size"),
                  "architecture": {key: run.config.get(key) for key in ("context_length", "layers", "width", "heads")}},
        "training": {key: run.config.get(key) for key in ("steps", "batch_size", "learning_rate", "seed", "validation_split", "target_tokens", "budget_mode", "parameters", "training_context_length", "planned_training_tokens", "tokens_per_parameter", "chinchilla_target_tokens", "early_stopping", "patience", "min_delta", "available_training_bytes", "expected_max_source_reuse")},
        "result": run.metadata_.get("training_result"),
        "tokenizer": {"name": "utf8-byte", "vocab_size": 256},
        "datasets": [{"id": item.get("id"), "name": item.get("name"), "sha256": item.get("sha256"),
                      "bytes": item.get("bytes"), "example": item.get("example", False), "weight": item.get("weight"), "validation": "last-10-percent",
                      "content_url": f"/api/datasets/{item.get('id')}/content"}
                     for item in run.config.get("mix", [])],
    }


@router.get("/datasets")
def datasets(session=Depends(session_scope), user=Depends(require_user)):
    return [describe(d) for d in session.scalars(select(Dataset).options(load_only(Dataset.id, Dataset.name, Dataset.byte_count, Dataset.example, Dataset.sha256, raiseload=True)).where(or_(Dataset.example == True, Dataset.owner_id == user.id)).order_by(Dataset.created_at))]


@router.post("/datasets", status_code=201)
async def upload_dataset(file: UploadFile = File(...), session=Depends(session_scope), user=Depends(require_user)):
    raw = await file.read(2_000_001)
    if len(raw) > 2_000_000:
        raise HTTPException(413, "Use a text file smaller than 2 MB for local training.")
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(422, "Please upload a UTF-8 text file.")
    if len(content.strip()) < 100 or "\x00" in content:
        raise HTTPException(422, "Add at least 100 characters of plain text.")
    digest = hashlib.sha256(content.encode()).hexdigest()
    existing = session.scalar(select(Dataset).where(Dataset.sha256 == digest, Dataset.owner_id == user.id))
    if existing:
        return describe(existing)
    dataset = Dataset(owner_id=user.id, name=(file.filename or "Untitled text")[:200], content=content, sha256=digest, example=False)
    session.add(dataset)
    session.commit()
    return describe(dataset)


class MixItem(BaseModel):
    dataset_id: str
    weight: int = Field(ge=1, le=100)


class TrainingInput(BaseModel):
    name: str = Field(min_length=8, max_length=120)
    mix: list[MixItem] = Field(min_length=1, max_length=20)
    steps: int = Field(default=100, ge=10, le=2000)
    batch_size: int = Field(default=8, ge=1, le=32)
    learning_rate: float = Field(default=0.003, ge=0.0001, le=0.1, allow_inf_nan=False)
    seed: int = Field(default=42, ge=0, le=2**32-1)
    model_size: Literal["tiny", "small", "8m", "16m", "32m", "64m", "128m"] = "tiny"
    compute: Literal["cpu", "runpod"] = "cpu"
    budget_mode: Literal["manual", "chinchilla", "tokens"] = "manual"
    max_runtime_seconds: int = Field(default=3600, ge=600, le=86400)
    early_stopping: bool = True
    patience: int = Field(default=20, ge=5, le=100)
    min_delta: float = Field(default=0.01, ge=0, le=1, allow_inf_nan=False)
    target_tokens: int = Field(default=100_000_000, ge=100_000, le=10_000_000_000)

    @model_validator(mode="after")
    def validate_mix(self):
        self.name = self.name.strip()
        letters = [c.lower() for c in self.name if c.isalpha()]
        words = re.sub(r"[\W_\d]+", " ", self.name.lower()).split()
        generic = {"test", "run", "training", "new", "untitled", "trening", "nowy", "nazwa", "asdf", "qwerty"}
        if len(self.name) < 8 or len(letters) < 4 or len(set(letters)) < 2 or all(w in generic for w in words):
            raise ValueError("Use a descriptive run name (8–120 characters), including the model, dataset or experiment; for example: Polish GPT - Wikipedia baseline.")
        if sum(d.weight for d in self.mix) != 100:
            raise ValueError("Dataset percentages must add up to 100.")
        if len({d.dataset_id for d in self.mix}) != len(self.mix):
            raise ValueError("Each dataset can only appear once.")
        return self


@router.post("/training", status_code=201)
def launch(body: TrainingInput, session=Depends(session_scope), user=Depends(require_user)):
    from .gpu_training import allowed, enqueue
    from .models import GPUJob
    if body.compute == 'runpod':
        if not allowed(user, session):raise HTTPException(403, 'RunPod access is not enabled for this account.')
        if body.max_runtime_seconds>settings.runpod_max_seconds:raise HTTPException(422, 'Requested duration exceeds the server GPU time limit.')
        if body.model_size in ('tiny','small'):raise HTTPException(422, 'Choose a GPU model from 8M to 128M.')
    elif body.model_size not in ('tiny','small'):
        raise HTTPException(422, 'Models 8M and larger require RunPod.')
    with launch_lock:
        if body.compute == 'runpod':
            pending = list(session.scalars(select(GPUJob).where(GPUJob.cleanup_done==False)))
            if len(pending) >= settings.runpod_max_pending:
                raise HTTPException(409, 'The GPU queue is full. Wait for a run to finish.')
            owned = session.scalars(select(Run.id).where(
                Run.id.in_([j.run_id for j in pending]), Run.owner_id==user.id)).all()
            if len(owned) >= settings.runpod_max_pending_per_user:
                raise HTTPException(409, f'You already have {settings.runpod_max_pending_per_user} active GPU runs. Wait for one to finish.')
        else:
            active = session.scalars(select(Run).where(Run.state.in_(["running", "queued", "stopping"])))
            if sum(r.metadata_.get("engine") == "tiny-transformer" and r.config.get("compute", "cpu") == "cpu" for r in active) >= 5:
                raise HTTPException(409, "Five CPU runs are already active. Wait for one to finish.")
        mix = []
        for item in body.mix:
            d = session.get(Dataset, item.dataset_id)
            if not d or (not d.example and d.owner_id != user.id):
                raise HTTPException(422, "A selected dataset no longer exists.")
            mix.append({**describe(d), "weight": item.weight})
        project = session.scalar(select(Project).where(Project.name == "Training studio"))
        if not project:
            project = Project(name="Training studio")
            session.add(project)
            session.flush()
        run_id = str(uuid4())
        model_config = MODEL_PRESETS[body.model_size]
        config = {**body.model_dump(exclude={"name", "mix"}), "mix": mix, "model": model_config["label"], "validation_split": 0.1, **model_config["architecture"]}
        config.update(plan_training(body, mix))
        session.add(Run(id=run_id, owner_id=user.id, project_id=project.id, name=body.name.strip(), state="queued", is_public=True, config=config, metadata_={"engine": "tiny-transformer", "device": "RunPod GPU" if body.compute=="runpod" else "CPU"}))
        if body.compute == "runpod":enqueue(session, session.get(Run, run_id))
        session.commit()
        if body.compute == "cpu":executor.submit(train, run_id)
        return {"id": run_id, "manifest_url": f"/api/training/{run_id}/manifest"}


@router.post("/training/{run_id}/stop")
def cancel(run_id: str, session=Depends(session_scope), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    if run.metadata_.get("engine") != "tiny-transformer":
        raise HTTPException(404, "Local training run not found")
    if run.state in ("running", "queued"):
        run.state = "stopping"
        session.commit()
    return {"state": run.state}


@router.get("/training/{run_id}/manifest")
def manifest(run_id: str, session=Depends(session_scope), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    if run.metadata_.get("engine") != "tiny-transformer":
        raise HTTPException(404, "Training run not found")
    return training_manifest(run)


@router.get("/leaderboard")
def leaderboard(sort: str = "val_loss", order: str = "asc", session=Depends(session_scope), user=Depends(current_user)):
    """Rank completed local models by their final validation result."""
    if sort not in {"val_loss", "perplexity", "throughput", "started_at"}:
        raise HTTPException(422, "Sort by val_loss, perplexity, throughput, or started_at.")
    if order not in {"asc", "desc"}:
        raise HTTPException(422, "Order must be asc or desc.")
    models = []
    for run in session.scalars(select(Run).where(Run.state == "finished", Run.is_public == True)):
        if run.metadata_.get("engine") != "tiny-transformer":
            continue
        latest = {}
        for metric in session.scalars(select(Metric).where(Metric.run_id == run.id).order_by(Metric.step.desc(), Metric.id.desc())):
            latest.setdefault(metric.key, metric.value)
        if latest.get("val/loss") is None:
            continue
        result = run.metadata_.get("training_result", {})
        latest["val/loss"] = result.get("best_val_loss", latest["val/loss"])
        latest["val/perplexity"] = result.get("best_val_perplexity", latest.get("val/perplexity"))
        models.append({"id": run.id, "owner": session.get(Account, run.owner_id).username if run.owner_id else "Legacy", "is_owner": bool(user and run.owner_id == user.id), "name": run.name, "state": run.state, "started_at": run.started_at,
                       "ended_at": run.ended_at, "val_loss": latest.get("val/loss"),
                       "perplexity": latest.get("val/perplexity"), "train_loss": latest.get("train/loss"),
                       "throughput": latest.get("throughput/tokens_sec"), "steps": result.get("completed_steps", run.config.get("steps")),
                       "model_size": run.config.get("model_size"), "parameters": run.config.get("parameters"),
                       "mix": [{"name": d.get("name") if d.get("example") else "Private dataset", "weight": d.get("weight")} for d in run.config.get("mix", [])]})
    key = {"val_loss": "val_loss", "perplexity": "perplexity", "throughput": "throughput", "started_at": "started_at"}[sort]
    # Different model sizes are not comparable on raw loss/perplexity; rank within each size.
    grouped = {}
    for row in models:
        grouped.setdefault(row["model_size"] or "unknown", []).append(row)
    sizes = []
    for size, rows in grouped.items():
        rows.sort(key=lambda row: (row.get(key) is None, row.get(key) or 0), reverse=order == "desc")
        for rank, row in enumerate(rows, 1):
            row["rank"] = rank
        sizes.append({"model_size": size, "parameters": rows[0]["parameters"], "models": rows})
    sizes.sort(key=lambda g: g["parameters"] or 0)
    return {"sort": sort, "order": order, "sizes": sizes}


class VisibilityInput(BaseModel):
    is_public: bool


@router.patch("/training/{run_id}/visibility")
def visibility(run_id: str, body: VisibilityInput, session=Depends(session_scope), user=Depends(require_user)):
    run = owned_run(session, run_id, user)
    if run.state != "finished" or run.metadata_.get("engine") != "tiny-transformer":
        raise HTTPException(409, "Only completed studio runs can be published.")
    run.is_public = body.is_public
    session.commit()
    return {"is_public": run.is_public}


def train(run_id):
    try:
        _train(run_id)
    except Exception:
        with SessionLocal() as session:
            run = session.get(Run, run_id)
            run.state = "failed"
            run.ended_at = datetime.now(timezone.utc)
            session.add(RunLog(run_id=run_id, level="error", message="Training failed. Check server logs and try a smaller run."))
            session.commit()
        import logging
        logging.exception("Training failed for %s", run_id)


MODEL_PRESETS = {
    "tiny": {"label": "Tiny transformer · 134,912 parameters", "architecture": {"context_length": 32, "layers": 2, "width": 64, "heads": 4}},
    "small": {"label": "Small transformer · 391,008 parameters", "architecture": {"context_length": 64, "layers": 3, "width": 96, "heads": 4}},
}

from .gpu_training import PRESETS as GPU_PRESETS
MODEL_PRESETS.update(GPU_PRESETS)


def plan_training(body, mix):
    preset = MODEL_PRESETS[body.model_size]
    parameters = preset.get("parameters") or (134_912 if body.model_size == "tiny" else 391_008)
    # Match batch() exactly: the shortest training split limits all sequences.
    length = min(preset["architecture"]["context_length"], min(int(d["bytes"] * .9) - 1 for d in mix))
    target = 20 * parameters
    steps = math.ceil(target / (body.batch_size * length)) if body.budget_mode == "chinchilla" else math.ceil(body.target_tokens / (body.batch_size * length)) if body.budget_mode == "tokens" else body.steps
    tokens = steps * body.batch_size * length
    return {"steps": steps, "parameters": parameters, "training_context_length": length,
            "planned_training_tokens": tokens, "tokens_per_parameter": tokens / parameters,
            "chinchilla_target_tokens": target,
            "available_training_bytes": sum(int(d["bytes"] * .9) for d in mix),
            "expected_max_source_reuse": max(tokens * d["weight"] / 100 / int(d["bytes"] * .9) for d in mix)}


from .native_model import TinyTransformer


def _holdout_split(source, seed, seen):
    """Whole-document content-hash holdout with cross-source dedup.

    Splits a source on blank-line document boundaries and assigns each unique
    document to training or the seeded ~10% validation holdout by a hash of its
    content, so a document never spans train and eval and duplicate documents
    across sources are dropped. Falls back to a contiguous 90/10 byte split when
    a source has fewer than two distinct documents, so a run never fails on it.
    """
    documents = [d for d in source.split(b"\n\n") if d.strip()]
    unique = []
    picked = set()
    for document in documents:
        digest = hashlib.sha256(document).hexdigest()
        if digest in seen or digest in picked:
            continue
        picked.add(digest)
        unique.append((digest, document))
    if len(unique) < 2:
        cut = int(len(source) * 0.9)
        return source[:cut], source[cut:]
    ordered = sorted(unique, key=lambda u: hashlib.sha256(f"{seed}:{u[0]}".encode()).hexdigest())
    holdout = {digest for digest, _ in ordered[:max(1, len(ordered) // 10)]}
    train, val = bytearray(), bytearray()
    for digest, document in unique:
        seen.add(digest)
        target = val if digest in holdout else train
        if target:
            target += b"\n\n"
        target += document
    return bytes(train), bytes(val)


def _train(run_id):
    torch.set_num_threads(1)
    with SessionLocal() as session:
        run = session.get(Run, run_id)
        cfg = run.config
        raw = [session.get(Dataset, d["id"]).content.encode() for d in cfg["mix"]]
        if run.state != "stopping":
            run.state = "running"
        session.add(RunLog(run_id=run_id, message="Training a tiny causal transformer from scratch on CPU. A seeded ~10% content-hash holdout of whole documents is reserved for validation; duplicate documents are removed so train and validation stay disjoint."))
        session.commit()
    torch.manual_seed(cfg["seed"])
    architecture = MODEL_PRESETS.get(cfg.get("model_size", "tiny"), MODEL_PRESETS["tiny"])["architecture"]
    model = TinyTransformer(**architecture)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg["learning_rate"])
    holdout_seen = set()
    train_data, val_data = [], []
    for source in raw:
        train_bytes, val_bytes = _holdout_split(source, cfg["seed"], holdout_seen)
        train_data.append(torch.tensor(list(train_bytes), dtype=torch.long))
        val_data.append(torch.tensor(list(val_bytes), dtype=torch.long))
    probabilities = torch.tensor([d["weight"] / 100 for d in cfg["mix"]])
    train_rng = torch.Generator().manual_seed(cfg["seed"])
    validation_rng = torch.Generator().manual_seed(cfg["seed"] + 1)
    def batch(sources, size, rng):
        length = min(cfg["context_length"], min(len(d)-1 for d in sources))
        choices = torch.multinomial(probabilities, size, replacement=True, generator=rng)
        sequences = []
        for choice in choices.tolist():
            source = sources[choice]
            pos = torch.randint(len(source)-length, (1,), generator=rng).item()
            sequences.append(source[pos:pos+length+1])
        tokens = torch.stack(sequences)
        return tokens[:, :-1], tokens[:, 1:]
    vx, vy = batch(val_data, 32, validation_rng)
    def validation_loss():
        model.eval()
        with torch.no_grad():
            return F.cross_entropy(model(vx).reshape(-1, 256), vy.reshape(-1)).item()

    best_loss = validation_loss()
    best_state = copy.deepcopy(model.state_dict())
    best_step = 0
    patience_loss = best_loss
    stale_checks = 0
    stop_reason = "step_limit"
    completed_steps = 0
    with SessionLocal() as session:
        session.add(Metric(run_id=run_id, key="val/loss", step=0, value=best_loss))
        session.add(Metric(run_id=run_id, key="val/perplexity", step=0, value=math.exp(best_loss)))
        session.commit()
    start = time.monotonic()
    final_state = "finished"
    seen_tokens = 0
    for step in range(1, cfg["steps"]+1):
        with SessionLocal() as session:
            run = session.get(Run, run_id)
            if stopping.is_set() or run.state == "stopping":
                final_state = "interrupted" if stopping.is_set() else "cancelled"
                break
        model.train()
        x, y = batch(train_data, cfg["batch_size"], train_rng)
        logits = model(x)
        loss = F.cross_entropy(logits.reshape(-1, 256), y.reshape(-1))
        if not torch.isfinite(loss):
            raise ValueError("Non-finite training loss")
        optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        seen_tokens += x.numel()
        completed_steps = step
        if step <= 100 or step % 10 == 0 or step == cfg["steps"]:
            val_loss = validation_loss()
            if not math.isfinite(val_loss):
                raise ValueError("Non-finite validation loss")
            if val_loss < best_loss:
                best_loss, best_step = val_loss, step
                best_state = copy.deepcopy(model.state_dict())
            if val_loss < patience_loss - cfg.get("min_delta", 0.01):
                patience_loss = val_loss
                stale_checks = 0
            else:
                stale_checks += 1
            values = {"train/loss": loss.item(), "val/loss": val_loss, "val/perplexity": math.exp(val_loss), "throughput/tokens_sec": seen_tokens/max(time.monotonic()-start, 1e-3), "progress": step/cfg["steps"]*100, "training/tokens_seen": seen_tokens}
            with SessionLocal() as session:
                for key, value in values.items():
                    session.add(Metric(run_id=run_id, key=key, step=step, value=value))
                session.commit()
            if cfg.get("early_stopping", True) and stale_checks >= cfg.get("patience", 20):
                stop_reason = "early_stopping"
                break
    with SessionLocal() as session:
        run = session.get(Run, run_id)
        if final_state == "finished" and run.state == "stopping":
            final_state = "cancelled"
        run.state = final_state
        run.metadata_ = {**run.metadata_, "training_result": {
            "stop_reason": stop_reason if final_state == "finished" else final_state,
            "completed_steps": completed_steps, "tokens_seen": seen_tokens,
            "best_step": best_step, "best_val_loss": best_loss,
            "best_val_perplexity": math.exp(best_loss),
            "checkpoint_selection": "lowest_validation_loss",
        }}
        if final_state == "finished":
            folder = settings.artifact_dir / run_id
            folder.mkdir(parents=True, exist_ok=True)
            checkpoint = folder / "model.pt"
            torch.save({"format": "fabryka-transformer-v1", "config": cfg, "state_dict": best_state, "best_step": best_step, "best_val_loss": best_loss}, checkpoint)
            manifest = folder / "recipe.json"
            manifest.write_text(json.dumps(training_manifest(run), indent=2))
            for path in (checkpoint, manifest):
                session.add(Artifact(run_id=run_id, name=path.name, storage_key=f"{run_id}/{path.name}", size=path.stat().st_size))
        run.state = final_state
        run.ended_at = datetime.now(timezone.utc)
        session.add(RunLog(run_id=run_id, message=f"Training complete ({stop_reason}) after {completed_steps} updates. Saved best validation checkpoint from step {best_step} (loss {best_loss:.4f})." if final_state == "finished" else "Training stopped."))
        session.commit()
