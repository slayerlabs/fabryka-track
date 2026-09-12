"""Append-only, account-private research history. No execution or allocation."""
from typing import Literal
from uuid import UUID
from datetime import timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from .accounts import require_user
from .database import session_scope
from .models import ResearchNote

router = APIRouter(prefix="/api/research/rfc-005")
TASK = "rfc-005"


class NoteInput(BaseModel):
    event_id: UUID
    stage: Literal["readiness", "proxies", "scale-check", "main", "extension", "confirmation"]
    kind: Literal["progress", "finding", "decision", "blocker", "next-step"]
    body: str = Field(min_length=1, max_length=20000)
    evidence: list[HttpUrl] = Field(default_factory=list, max_length=10)


def serialize(note):
    return {"id": note.id, "event_id": note.event_id, "task": note.task,
            "stage": note.stage, "kind": note.kind, "body": note.body,
            "evidence": note.evidence, "created_at": note.created_at.replace(tzinfo=timezone.utc).isoformat()}


def existing(session, user, event):
    return session.scalar(select(ResearchNote).where(ResearchNote.owner_id == user.id,
                                                    ResearchNote.event_id == str(event)))


@router.post("/notes")
def append(body: NoteInput, user=Depends(require_user), session=Depends(session_scope)):
    values = {"task": TASK, "stage": body.stage, "kind": body.kind, "body": body.body.strip(),
              "evidence": [str(url) for url in body.evidence]}
    if not values["body"]:
        raise HTTPException(422, "Write a progress note before saving.")
    note = existing(session, user, body.event_id)
    if not note:
        note = ResearchNote(owner_id=user.id, event_id=str(body.event_id), **values)
        session.add(note)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            note = existing(session, user, body.event_id)
            if note is None:
                raise
    if any(getattr(note, key) != value for key, value in values.items()):
        raise HTTPException(409, "This event ID already belongs to another note. Use a new event ID.")
    return serialize(note)


@router.get("/notes")
def listing(before: int | None = Query(None, ge=1), user=Depends(require_user), session=Depends(session_scope)):
    query = select(ResearchNote).where(ResearchNote.owner_id == user.id, ResearchNote.task == TASK)
    if before is not None:
        query = query.where(ResearchNote.id < before)
    rows = session.scalars(query.order_by(ResearchNote.id.desc()).limit(51)).all()
    return JSONResponse({"notes": [serialize(n) for n in rows[:50]],
            "next_before": rows[49].id if len(rows) > 50 else None}, headers={"Cache-Control": "no-store"})


@router.get("/scratchpad.md", response_class=PlainTextResponse)
def export(user=Depends(require_user), session=Depends(session_scope)):
    notes = session.scalars(select(ResearchNote).where(ResearchNote.owner_id == user.id,
        ResearchNote.task == TASK).order_by(ResearchNote.id)).all()
    lines = ["# RFC-005 research scratchpad", "", "Task: Train a 250M English base model",
             "Specification: https://track.fabryka.ai/goals/250m-english-base-model.md", ""]
    for note in notes:
        lines += [f"## {serialize(note)['created_at']} | {note.stage} | {note.kind}", "", note.body, ""]
        lines += [f"- Evidence: {url}" for url in note.evidence]
        lines.append("")
    if not notes:
        lines.append("No research progress has been recorded in this account yet.")
    return PlainTextResponse("\n".join(lines), headers={"Cache-Control": "no-store"})
