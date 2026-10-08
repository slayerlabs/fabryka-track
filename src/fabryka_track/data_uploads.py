import logging
import re
import threading
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .accounts import current_user, require_user
from .database import SessionLocal
from .models import DataUploadDeclaration, HuggingFaceIdentity
from .settings import settings

router = APIRouter(prefix="/api/uploads")
logger = logging.getLogger(__name__)
_client = None
_client_lock = threading.Lock()
DECLARATION_VERSION = "upload-declaration-v0-placeholder"
PROTOCOL = "job-v1"
SUBJECT = re.compile(r"[A-Za-z0-9_-]{1,64}")
USERNAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
UNAVAILABLE = "Data uploads are temporarily unavailable. Try again shortly."
REFUSED = "The data pipeline refused this request."
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
    "integrity_mismatch": "The uploaded file does not match what was declared. Start a new upload.",
    "body_too_large": "The request was too large for the data pipeline.",
    "unsupported_version": "Track and the data pipeline disagree on the protocol version. Try again later.",
    "idempotency_key_required": "The request was missing its action key. Reload the page and try again.",
    "method_not_allowed": "The data pipeline does not support this action.",
    "stale_attempt": "This upload attempt is no longer current. Reload the page.",
    "lease_expired": "The processing slot for this upload expired. Start a new upload.",
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
    def __init__(self, status, code, message, request_id=None):
        self.status, self.code, self.message, self.request_id = status, code, message, request_id


@dataclass(frozen=True)
class Caller:
    account_id: str
    subject: str
    username: str


def uploader(request: Request):
    # Own short session instead of Depends(session_scope), which would hold a connection for the controller call.
    with SessionLocal() as session:
        user = require_user(current_user(request, session))
        if not settings.pipeline_username or not settings.pipeline_password:
            raise HTTPException(503, "Data uploads are not configured.")
        identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
        if not identity or not SUBJECT.fullmatch(identity.subject):
            raise HTTPException(403, "Sign in with Hugging Face to upload data.")
        if not USERNAME.fullmatch(identity.username):
            raise HTTPException(403, "Your Hugging Face account has no username Track can use. "
                                     "Sign out and sign in with Hugging Face again.")
        return Caller(user.id, identity.subject, identity.username)


def controller_client():
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(base_url=settings.pipeline_url.rstrip("/"),
                                   auth=(settings.pipeline_username, settings.pipeline_password),
                                   timeout=httpx.Timeout(20, connect=5),
                                   limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
        return _client


def object_body(response):
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def failure(method, path, status, code, message, request_id=None, *, reply_status=None):
    logger.warning("controller %s %s failed: status=%s code=%s request_id=%s", method, path, status, code, request_id)
    return ControllerError(reply_status or status or 502, code, message, request_id)


def call(caller, method, path, *, json=None, params=None, action_key=None):
    headers = {"X-Pipeline-User": caller.subject, "X-Pipeline-User-Name": caller.username}
    if method != "GET":
        headers["X-Pipeline-Request"] = "1"
    if action_key:
        headers["Idempotency-Key"] = action_key
    try:
        response = controller_client().request(method, "/jobs/v1" + path, json=json, params=params, headers=headers)
    except httpx.HTTPError as error:
        raise failure(method, path, None, type(error).__name__, UNAVAILABLE)
    body = object_body(response)
    if body is None:
        raise failure(method, path, response.status_code, "provider_unavailable", UNAVAILABLE, reply_status=502)
    if response.is_success:
        return response.status_code, body
    status, code, request_id = response.status_code, body.get("code"), body.get("request_id")
    # 401 and forbidden_origin mean Track's own controller credentials or setup were refused, not the browser.
    if status == 401 or code == "forbidden_origin":
        raise failure(method, path, status, code, UNAVAILABLE, request_id, reply_status=502)
    message = MESSAGES.get(code) or (UNAVAILABLE if status >= 500 else REFUSED)
    raise failure(method, path, status, code, message, request_id)


def controller_error_response(_request, error):
    return JSONResponse({"detail": error.message, "code": error.code, "request_id": error.request_id},
                        status_code=error.status)


def forward(caller, method, path, **kwargs):
    status, body = call(caller, method, path, **kwargs)
    return JSONResponse(body, status_code=status)


@router.get("")
def list_uploads(cursor: str | None = None, caller=Depends(uploader)):
    params = {"limit": 20, **({"cursor": cursor} if cursor else {})}
    return forward(caller, "GET", "/jobs", params=params)


@router.post("")
def create_upload(body: CreateUpload, caller=Depends(uploader)):
    payload = {"protocol": PROTOCOL, "pipeline": "dynaword-upload", "input": body.input.model_dump(),
               "parameters": body.parameters.model_dump(exclude_none=True)}
    status, job = call(caller, "POST", "/jobs", json=payload, action_key=body.action_key)
    with SessionLocal() as session:
        if not session.get(DataUploadDeclaration, job["job_id"]):
            session.add(DataUploadDeclaration(job_id=job["job_id"], account_id=caller.account_id,
                                              version=body.declaration.version))
            try:
                session.commit()
            except IntegrityError:
                # A concurrent create with the same action key already recorded this job's declaration.
                session.rollback()
    return JSONResponse(job, status_code=status)


@router.post("/{job_id}/parts")
def part_grant(job_id: UUID, body: PartRequest, caller=Depends(uploader)):
    return forward(caller, "POST", f"/jobs/{job_id}/parts", json={"protocol": PROTOCOL, **body.model_dump()})


@router.post("/{job_id}/confirm")
def confirm_upload(job_id: UUID, body: ConfirmUpload, caller=Depends(uploader)):
    payload = {"protocol": PROTOCOL, **body.model_dump(exclude={"action_key"})}
    return forward(caller, "POST", f"/jobs/{job_id}/confirm", json=payload, action_key=body.action_key)


@router.post("/{job_id}/cancel")
def cancel_upload(job_id: UUID, body: CancelUpload, caller=Depends(uploader)):
    return forward(caller, "POST", f"/jobs/{job_id}/cancel", json={"protocol": PROTOCOL}, action_key=body.action_key)


@router.get("/{job_id}")
def upload_status(job_id: UUID, caller=Depends(uploader)):
    return forward(caller, "GET", f"/jobs/{job_id}")


@router.get("/{job_id}/report")
def upload_report(job_id: UUID, caller=Depends(uploader)):
    return forward(caller, "GET", f"/jobs/{job_id}/report")


@router.get("/{job_id}/result")
def upload_result(job_id: UUID, diagnostic: bool = False, caller=Depends(uploader)):
    return forward(caller, "GET", f"/jobs/{job_id}/result", params={"diagnostic": "true"} if diagnostic else None)
