import re
from typing import Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .accounts import require_user
from .database import session_scope
from .models import DataUploadDeclaration, HuggingFaceIdentity
from .settings import settings

router = APIRouter(prefix="/api/uploads")
DECLARATION_VERSION = "upload-declaration-v0-placeholder"
PROTOCOL = "job-v1"
SUBJECT = re.compile(r"[A-Za-z0-9_-]{1,64}")
USERNAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
UNAVAILABLE = "Data uploads are temporarily unavailable. Try again shortly."
MAX_BYTES = 512 * 1024 * 1024
ACTION_KEY = r"^[!-~]{16,128}$"
MESSAGES = {
    "user_limit_reached": "You already have an upload in progress. Wait for it to finish or cancel it.",
    "guest_capacity_full": "Guest upload capacity is full right now. Try again later.",
    "quota_exceeded": "The data pipeline is at capacity. Try again later.",
    "not_found": "Upload not found.",
    "invalid_state": "This upload cannot do that in its current state.",
    "transfer_not_ready": "The upload is still being prepared. Try again in a moment.",
    "expired": "This upload has expired.",
    "report_pending": "The report is not ready yet.",
    "result_pending": "The result is not ready yet.",
    "diagnostic_required": "Only a diagnostic result is available for this upload.",
    "no_result": "This upload has no result to download.",
    "idempotency_conflict": "This action was already submitted with different details. Reload the page and try again.",
    "invalid_request": "The data pipeline rejected the request. Check the file and form, then try again.",
    "provider_unavailable": "Storage is temporarily unavailable. Try again shortly.",
}


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UploadInput(Body):
    format: Literal["jsonl", "parquet"]
    encoded_bytes: int = Field(ge=1, le=MAX_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    filename: str = Field(min_length=1, max_length=255)


class UploadParameters(Body):
    source: str = Field(pattern=r"^[a-z0-9][a-z0-9_]*$", max_length=128)
    added: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    license: str | None = Field(default=None, max_length=4096)
    author: str | None = Field(default=None, max_length=4096)
    source_ref: str | None = Field(default=None, max_length=4096)
    per_record_provenance: StrictBool | None = None
    mask_names: StrictBool


class Declaration(Body):
    accepted: Literal[True]
    version: Literal[DECLARATION_VERSION]


class CreateUpload(Body):
    action_key: str = Field(pattern=ACTION_KEY)
    input: UploadInput
    parameters: UploadParameters
    declaration: Declaration


class PartRequest(Body):
    part_number: int = Field(ge=1, le=10000)


class UploadedPart(Body):
    part_number: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=256)


class ConfirmUpload(Body):
    action_key: str = Field(pattern=ACTION_KEY)
    parts: list[UploadedPart] = Field(min_length=1, max_length=10000)
    encoded_bytes: int = Field(ge=1, le=MAX_BYTES)
    input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CancelUpload(Body):
    action_key: str = Field(pattern=ACTION_KEY)


class ControllerError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def uploader(user=Depends(require_user), session=Depends(session_scope)):
    if not settings.pipeline_username or not settings.pipeline_password:
        raise HTTPException(503, "Data uploads are not configured.")
    identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
    if not identity or not SUBJECT.fullmatch(identity.subject) or not USERNAME.fullmatch(identity.username):
        raise HTTPException(403, "Sign in with Hugging Face to upload data.")
    return user, identity


def call(identity, method, path, *, json=None, params=None, action_key=None):
    headers = {"X-Pipeline-User": identity.subject, "X-Pipeline-User-Name": identity.username}
    if method != "GET":
        headers["X-Pipeline-Request"] = "1"
    if action_key:
        headers["Idempotency-Key"] = action_key
    try:
        with httpx.Client(base_url=settings.pipeline_url.rstrip("/"), timeout=30,
                          auth=(settings.pipeline_username, settings.pipeline_password)) as client:
            response = client.request(method, "/jobs/v1" + path, json=json, params=params, headers=headers)
    except httpx.HTTPError:
        raise ControllerError(502, "provider_unavailable", UNAVAILABLE)
    if response.is_success:
        return response.status_code, response.json()
    try:
        code = response.json().get("code")
    except ValueError:
        code = None
    # A 401 here means Track's own controller credentials were refused, not the browser session.
    if response.status_code == 401:
        raise ControllerError(502, code, UNAVAILABLE)
    raise ControllerError(response.status_code, code, MESSAGES.get(code, UNAVAILABLE))


def forward(identity, method, path, **kwargs):
    try:
        status, body = call(identity, method, path, **kwargs)
        return JSONResponse(body, status_code=status)
    except ControllerError as error:
        return JSONResponse({"detail": error.message, "code": error.code}, status_code=error.status)


@router.get("")
def list_uploads(cursor: str | None = None, caller=Depends(uploader)):
    params = {"limit": 20, **({"cursor": cursor} if cursor else {})}
    return forward(caller[1], "GET", "/jobs", params=params)


@router.post("")
def create_upload(body: CreateUpload, caller=Depends(uploader), session=Depends(session_scope)):
    user, identity = caller
    payload = {"protocol": PROTOCOL, "pipeline": "dynaword-upload", "input": body.input.model_dump(),
               "parameters": body.parameters.model_dump(exclude_none=True)}
    try:
        status, job = call(identity, "POST", "/jobs", json=payload, action_key=body.action_key)
    except ControllerError as error:
        return JSONResponse({"detail": error.message, "code": error.code}, status_code=error.status)
    if not session.get(DataUploadDeclaration, job["job_id"]):
        session.add(DataUploadDeclaration(job_id=job["job_id"], account_id=user.id, version=body.declaration.version))
        try:
            session.commit()
        except IntegrityError:
            # A concurrent create with the same action key already recorded this job's declaration.
            session.rollback()
    return JSONResponse(job, status_code=status)


@router.post("/{job_id}/parts")
def part_grant(job_id: UUID, body: PartRequest, caller=Depends(uploader)):
    return forward(caller[1], "POST", f"/jobs/{job_id}/parts", json={"protocol": PROTOCOL, **body.model_dump()})


@router.post("/{job_id}/confirm")
def confirm_upload(job_id: UUID, body: ConfirmUpload, caller=Depends(uploader)):
    payload = {"protocol": PROTOCOL, **body.model_dump(exclude={"action_key"})}
    return forward(caller[1], "POST", f"/jobs/{job_id}/confirm", json=payload, action_key=body.action_key)


@router.post("/{job_id}/cancel")
def cancel_upload(job_id: UUID, body: CancelUpload, caller=Depends(uploader)):
    return forward(caller[1], "POST", f"/jobs/{job_id}/cancel", json={"protocol": PROTOCOL}, action_key=body.action_key)


@router.get("/{job_id}")
def upload_status(job_id: UUID, caller=Depends(uploader)):
    return forward(caller[1], "GET", f"/jobs/{job_id}")


@router.get("/{job_id}/report")
def upload_report(job_id: UUID, caller=Depends(uploader)):
    return forward(caller[1], "GET", f"/jobs/{job_id}/report")


@router.get("/{job_id}/result")
def upload_result(job_id: UUID, diagnostic: bool = False, caller=Depends(uploader)):
    return forward(caller[1], "GET", f"/jobs/{job_id}/result", params={"diagnostic": "true"} if diagnostic else None)
