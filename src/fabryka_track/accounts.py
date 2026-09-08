"""Account sessions, API credentials and ownership checks."""
import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from .database import session_scope
from .models import Account, AccountSession, HuggingFaceIdentity, Run

router = APIRouter(prefix="/api/auth")
passwords = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))
COOKIE = "track_session"
_attempts = defaultdict(deque)
_rate_lock = threading.Lock()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def throttle(request, username=""):
    now = time.monotonic()
    keys = [("ip:" + (request.client.host if request.client else "unknown"), 30)]
    if username:
        keys.append(("user:" + username, 15))
    with _rate_lock:
        for key in list(_attempts):
            while _attempts[key] and _attempts[key][0] < now - 900:
                _attempts[key].popleft()
            if not _attempts[key]:
                del _attempts[key]
        for key, limit in keys:
            if len(_attempts[key]) >= limit:
                raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
        for key, _ in keys:
            _attempts[key].append(now)


def public_account(user):
    return {"id": user.id, "username": user.username, "has_api_key": bool(user.api_key_hash), "has_password": bool(user.password_hash)}


def current_user(request: Request, session=Depends(session_scope)):
    bearer = request.headers.get("authorization", "")
    if bearer.startswith("Bearer "):
        return session.scalar(select(Account).where(Account.api_key_hash == digest(bearer[7:])))
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    stored = session.get(AccountSession, digest(token))
    if not stored or stored.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        return None
    return session.get(Account, stored.account_id)


def require_user(user=Depends(current_user)):
    if not user:
        raise HTTPException(401, "Sign in to continue.")
    return user


def owned_run(session, run_id, user):
    run = session.get(Run, run_id)
    if not run or run.owner_id != user.id:
        raise HTTPException(404, "Run not found")
    return run


def verify(password, hashed):
    if not hashed:
        return False
    try:
        return passwords.verify(hashed, password)
    except VerificationError:
        return False


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_\-]+$")
    password: str = Field(min_length=12, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize(cls, value):
        return value.lower()


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=0, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class PasswordCheck(BaseModel):
    password: str = Field(default="", max_length=128)


def new_session(request, response, session, user):
    old = request.cookies.get(COOKIE)
    if old:
        session.execute(delete(AccountSession).where(AccountSession.id == digest(old)))
    session.execute(delete(AccountSession).where(AccountSession.expires_at < datetime.now(timezone.utc)))
    token = secrets.token_urlsafe(32)
    session.add(AccountSession(id=digest(token), account_id=user.id,
                               expires_at=datetime.now(timezone.utc) + timedelta(days=14)))
    session.commit()
    response.set_cookie(COOKIE, token, max_age=14*86400, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax", path="/")
    return public_account(user)


@router.get("/me")
def me(user=Depends(current_user), session=Depends(session_scope)):
    data = public_account(user) if user else None
    if user:
        identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
        data["huggingface_username"] = identity.username if identity else None
    return {"user": data}


@router.post("/register", status_code=201)
def register(body: Credentials, request: Request, response: Response, session=Depends(session_scope)):
    throttle(request, body.username)
    user = Account(username=body.username, password_hash=passwords.hash(body.password))
    session.add(user)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "This username is unavailable.")
    return {"user": new_session(request, response, session, user)}


@router.post("/login")
def login(body: Credentials, request: Request, response: Response, session=Depends(session_scope)):
    throttle(request, body.username)
    user = session.scalar(select(Account).where(Account.username == body.username))
    valid = verify(body.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, "Incorrect username or password.")
    if passwords.check_needs_rehash(user.password_hash):
        user.password_hash = passwords.hash(body.password)
    return {"user": new_session(request, response, session, user)}


@router.post("/logout")
def logout(request: Request, response: Response, session=Depends(session_scope)):
    token = request.cookies.get(COOKIE)
    if token:
        session.execute(delete(AccountSession).where(AccountSession.id == digest(token)))
        session.commit()
    response.delete_cookie(COOKIE, path="/", secure=request.url.scheme == "https", httponly=True, samesite="lax")
    return {"ok": True}


def confirm_credentials(request, session, user, password):
    if user.password_hash:
        if not verify(password, user.password_hash):
            raise HTTPException(401, "Incorrect current password.")
    else:
        stored = session.get(AccountSession, digest(request.cookies.get(COOKIE, '')))
        if (not stored or stored.account_id != user.id or request.headers.get('authorization') or
                stored.expires_at.replace(tzinfo=timezone.utc) - timedelta(days=14) < datetime.now(timezone.utc) - timedelta(minutes=5)):
            raise HTTPException(401, "Sign in with Hugging Face again before changing credentials.")


@router.post("/password")
def change_password(body: PasswordChange, request: Request, response: Response,
                    user=Depends(require_user), session=Depends(session_scope)):
    throttle(request, user.username)
    confirm_credentials(request, session, user, body.current_password)
    user.password_hash = passwords.hash(body.new_password)
    user.api_key_hash = None
    session.execute(delete(AccountSession).where(AccountSession.account_id == user.id))
    return {"user": new_session(request, response, session, user)}


@router.post("/api-key")
def api_key(body: PasswordCheck, request: Request, user=Depends(require_user), session=Depends(session_scope)):
    throttle(request, user.username)
    confirm_credentials(request, session, user, body.password)
    token = "ft_" + secrets.token_urlsafe(32)
    user.api_key_hash = digest(token)
    session.commit()
    return {"api_key": token}


@router.delete("/api-key")
def revoke_api_key(user=Depends(require_user), session=Depends(session_scope)):
    user.api_key_hash = None
    session.commit()
    return {"ok": True}
