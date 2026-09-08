"""Bounded, owner-authorized checkpoint sampling in an isolated process."""
import json
import subprocess
import sys
import threading
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from .accounts import owned_run, require_user
from .database import session_scope
from .hf_publish import checkpoint_path

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
    path = checkpoint_path(session, owned_run(session, run_id, user))
    if not _slot.acquire(blocking=False):
        raise HTTPException(429, 'Another sample is being generated. Try again shortly.')
    try:
        result = subprocess.run([sys.executable, '-m', 'fabryka_track.generation_worker', str(path)],
                                input=body.model_dump_json(), text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise HTTPException(503, 'Checkpoint generation failed. Try a shorter sample.')
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, 'Generation exceeded 90 seconds. Try fewer output bytes.')
    finally:
        _slot.release()
