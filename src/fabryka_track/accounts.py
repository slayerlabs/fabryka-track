"""Account sessions, API credentials and ownership checks."""
import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select

from .database import session_scope
from .models import Account, AccountSession, HuggingFaceIdentity, Run, RunSDKToken

router = APIRouter(prefix="/api/auth")
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
        key_hash = digest(bearer[7:])
        account = session.scalar(select(Account).where(Account.api_key_hash == key_hash))
        if account:
            return account
        token = session.get(RunSDKToken, key_hash)
        if not token or token.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
            return None
        run = session.get(Run, token.run_id)
        if not run or run.owner_id != token.account_id:
            return None
        allowed = {"/api/events", f"/api/runs/{token.run_id}", f"/api/runs/{token.run_id}/artifacts"}
        proxy_prefix = f"/api/runs/{token.run_id}/glint-proxy"
        if request.url.path not in allowed and request.url.path != proxy_prefix and not request.url.path.startswith(proxy_prefix + "/"):
            return None
        request.state.sdk_run_id = token.run_id
        return session.get(Account, token.account_id)
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


FORWARD_USER_HEADER = "X-Gollem-User"


@router.get("/forward-user")
def forward_user(request: Request, session=Depends(session_scope)):
    """Caddy `forward_auth` for same-host apps (ChatGoLLeM at /gollem/): always 204, never a body or a cookie.

    Only a browser cookie session counts (API keys and SDK tokens are ignored), and only the Hugging Face username of
    that account is exposed, as the `X-Gollem-User` response header. Caddy copies it to the app and strips the Cookie,
    so the app never sees the Track session. Anonymous visitors get 204 without the header.
    """
    headers = {"Cache-Control": "no-store"}
    token = request.cookies.get(COOKIE)
    stored = session.get(AccountSession, digest(token)) if token else None
    if stored and stored.expires_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc):
        identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == stored.account_id))
        if identity and identity.username:
            headers[FORWARD_USER_HEADER] = identity.username
    return Response(status_code=204, headers=headers)


@router.post("/logout")
def logout(request: Request, response: Response, session=Depends(session_scope)):
    token = request.cookies.get(COOKIE)
    if token:
        session.execute(delete(AccountSession).where(AccountSession.id == digest(token)))
        session.commit()
    response.delete_cookie(COOKIE, path="/", secure=request.url.scheme == "https", httponly=True, samesite="lax")
    return {"ok": True}


def confirm_credentials(request, session, user):
    identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
    stored = session.get(AccountSession, digest(request.cookies.get(COOKIE, '')))
    if (not identity or not stored or stored.account_id != user.id or request.headers.get('authorization') or
            stored.expires_at.replace(tzinfo=timezone.utc) - timedelta(days=14) < datetime.now(timezone.utc) - timedelta(minutes=5)):
        raise HTTPException(401, "Sign in with Hugging Face again before changing credentials.")


@router.post("/api-key")
def api_key(request: Request, user=Depends(require_user), session=Depends(session_scope)):
    throttle(request, user.username)
    token = "ft_" + secrets.token_urlsafe(32)
    user.api_key_hash = digest(token)
    session.commit()
    return {"api_key": token}


@router.delete("/api-key")
def revoke_api_key(user=Depends(require_user), session=Depends(session_scope)):
    user.api_key_hash = None
    session.commit()
    return {"ok": True}
