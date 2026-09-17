"""Bounded checkpoint sampling for owners and signed-in public-run viewers."""
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .accounts import require_user
from .database import session_scope
from .hf_publish import checkpoint_path
from .models import Run

router = APIRouter(prefix='/api/runs')
_slot = threading.Lock()

class GenerationInput(BaseModel):
    prompt: str = Field(min_length=1, max_length=2048)
    max_new_bytes: int = Field(default=256, ge=1, le=512)
    temperature: float = Field(default=0.8, ge=0, le=2)
    top_k: int = Field(default=40, ge=1, le=256)
    seed: int = Field(default=42, ge=0, le=2147483647)

@router.post('/{run_id}/generate')
def generate(run_id: str, body: GenerationInput, user=Depends(require_user), session=Depends(session_scope)):
    run = session.get(Run, run_id)
    if not run or not (run.owner_id == user.id or (run.is_public and run.state == 'finished')):
        raise HTTPException(404, 'Run not found')
    if run.state != 'finished' or run.metadata_.get('engine') != 'tiny-transformer':
        raise HTTPException(409, 'Generation requires a finished studio run with a saved checkpoint.')
    path = checkpoint_path(session, run)
    if not _slot.acquire(blocking=False):
        raise HTTPException(429, 'Another sample is being generated. Try again shortly.')
    try:
        # The published SDK wheel intentionally contains only ``fabryka``.  The
        # hosted tracker runs the backend from ``src``; make that source tree
        # visible to the worker subprocess as well when tests or a packaged
        # install invoke this endpoint.
        source_root = str(Path(__file__).resolve().parents[1])
        pythonpath = os.pathsep.join(filter(None, (source_root, os.environ.get('PYTHONPATH', ''))))
        worker_env = {**os.environ, 'PYTHONPATH': pythonpath}
        result = subprocess.run([sys.executable, '-m', 'fabryka_track.generation_worker', str(path)],
                                input=body.model_dump_json(), text=True, capture_output=True,
                                timeout=90, env=worker_env)
        if result.returncode:
            raise HTTPException(503, 'Checkpoint generation failed. Try a shorter sample.')
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, 'Generation exceeded 90 seconds. Try fewer output bytes.')
    finally:
        _slot.release()
