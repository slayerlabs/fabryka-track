"""Hugging Face authorization-code flow using CIMD and PKCE; publishing grants are used transiently."""
import base64
import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from .accounts import COOKIE, current_user, digest, new_session, throttle
from .database import session_scope
from .models import Account, HFPublication, HuggingFaceIdentity, OAuthAttempt
from .settings import settings

router = APIRouter()
FLOW_COOKIE = "track_hf_flow"
FLOW_PATH = "/api/auth/huggingface"


def client_id():
    return settings.public_url.rstrip('/') + '/.well-known/oauth-cimd'


def redirect_uri():
    return settings.public_url.rstrip('/') + FLOW_PATH + '/callback'


@router.get('/.well-known/oauth-cimd')
def metadata():
    return {"client_id": client_id(), "client_name": "Fabryka Track",
            "redirect_uris": [redirect_uri()], "token_endpoint_auth_method": "none",
            "client_uri": settings.public_url.rstrip('/')}


class StartInput(BaseModel):
    link: bool = False


@router.post(FLOW_PATH + '/start')
def start(body: StartInput, request: Request, response: Response,
          user=Depends(current_user), session=Depends(session_scope)):
    throttle(request)
    if body.link and (not user or not request.cookies.get(COOKIE) or request.headers.get('authorization')):
        raise HTTPException(401, 'Sign in to Track before connecting Hugging Face.')
    url, _ = begin_oauth(request, response, session, user.id if body.link else None, 'openid profile')
    session.commit()
    return {"url": url}


def begin_oauth(request, response, session, account_id, scopes, org_ids=None):
    state, browser, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    session.execute(delete(OAuthAttempt).where(OAuthAttempt.expires_at < datetime.now(timezone.utc)))
    session.add(OAuthAttempt(id=digest(state), browser_hash=digest(browser), verifier=verifier,
                            account_id=account_id,
                            session_hash=digest(request.cookies[COOKIE]) if account_id else None,
                            expires_at=datetime.now(timezone.utc) + timedelta(minutes=10)))
    response.set_cookie(FLOW_COOKIE, browser, httponly=True, secure=request.url.scheme == 'https',
                        samesite='lax', max_age=600, path=FLOW_PATH)
    url = 'https://huggingface.co/oauth/authorize?' + urlencode({
        "client_id": client_id(), "redirect_uri": redirect_uri(), "response_type": "code",
        "scope": scopes, "state": state, "code_challenge": challenge,
        "code_challenge_method": "S256", **({"orgIds": org_ids} if org_ids else {})})
    return url, digest(state)


def fetch_profile(code, verifier):
    return fetch_grant(code, verifier)[0]


def fetch_grant(code, verifier):
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        response = client.post('https://huggingface.co/oauth/token', data={
            'grant_type': 'authorization_code', 'client_id': client_id(),
            'redirect_uri': redirect_uri(), 'code': code, 'code_verifier': verifier})
        response.raise_for_status()
        token = response.json()['access_token']
        if not isinstance(token, str) or not token:
            raise ValueError('Missing token')
        response = client.get('https://huggingface.co/oauth/userinfo', headers={'Authorization': 'Bearer ' + token})
        response.raise_for_status()
        profile = response.json()
        if not isinstance(profile.get('sub'), str) or not 1 <= len(profile['sub']) <= 255:
            raise ValueError('Missing subject')
        return profile, token


def failure(request, message, status=400):
    # Messages are application constants, never provider-supplied text.
    response = HTMLResponse('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Hugging Face sign-in</title><link rel="stylesheet" href="/assets/ascii.css"><main style="max-width:38rem;margin:4rem auto;font-size:14px;padding:1rem"><h1>Hugging Face sign-in</h1><p>' + message + '</p><a href="/login">Return to sign in</a> · <a href="/account">Account settings</a></main>', status_code=status)
    response.delete_cookie(FLOW_COOKIE, path=FLOW_PATH, secure=request.url.scheme == 'https', httponly=True, samesite='lax')
    return response


@router.get(FLOW_PATH + '/callback')
def callback(request: Request, background_tasks: BackgroundTasks, state: str = '', code: str = '', error: str = '',
             user=Depends(current_user), session=Depends(session_scope)):
    attempt = session.get(OAuthAttempt, digest(state))
    browser = request.cookies.get(FLOW_COOKIE, '')
    if not attempt or not browser or not secrets.compare_digest(attempt.browser_hash, digest(browser)):
        return failure(request, 'This sign-in request is invalid. Please start again.')
    if attempt.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        return failure(request, 'This sign-in request expired. Please start again.')
    publication = session.scalar(select(HFPublication).where(HFPublication.oauth_state == attempt.id))
    verifier, account_id, session_hash = attempt.verifier, attempt.account_id, attempt.session_hash
    consumed = session.execute(delete(OAuthAttempt).where(OAuthAttempt.id == attempt.id)).rowcount
    session.commit()
    if consumed != 1:
        return failure(request, 'This sign-in request has already been used.')
    if error or not code:
        if publication:
            publication.status, publication.error = 'failed', 'HF authorization was cancelled. You can try again.'
            session.commit()
        return failure(request, 'Hugging Face sign-in was cancelled. Your Track account has not changed.')
    if account_id and (not user or user.id != account_id or digest(request.cookies.get(COOKIE, '')) != session_hash):
        return failure(request, 'Your Track session changed. Sign in and connect Hugging Face again.')
    if publication:
        from .hf_publish import authorized_upload
        return authorized_upload(publication, request, code, verifier, session, background_tasks)
    try:
        profile = fetch_profile(code, verifier)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return failure(request, 'Could not verify your Hugging Face account. Please try again.', 502)
    subject = profile['sub']
    hf_name = str(profile.get('preferred_username') or profile.get('name') or 'user')[:200]
    identity = session.get(HuggingFaceIdentity, subject)
    if account_id:
        existing = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == account_id))
        if (identity and identity.account_id != account_id) or (existing and existing.subject != subject):
            return failure(request, 'This account already has a different Hugging Face connection. No accounts were merged.', 409)
        target = session.get(Account, account_id)
    elif identity:
        target = session.get(Account, identity.account_id)
    else:
        # Never infer identity from a matching username or email address.
        stem = re.sub(r'[^a-z0-9_-]', '_', hf_name.lower())[:20] or 'user'
        username = 'hf_' + stem
        if session.scalar(select(Account).where(Account.username == username)):
            username += '_' + secrets.token_hex(3)
        target = Account(username=username, password_hash='')
        session.add(target)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            return failure(request, 'Another sign-in completed at the same time. Please sign in again.', 409)
    if not identity:
        session.add(HuggingFaceIdentity(subject=subject, account_id=target.id, username=hf_name))
    else:
        identity.username = hf_name
    response = RedirectResponse('/account', status_code=303)
    try:
        new_session(request, response, session, target)
    except IntegrityError:
        session.rollback()
        return failure(request, 'Another sign-in completed at the same time. Please sign in again.', 409)
    response.delete_cookie(FLOW_COOKIE, path=FLOW_PATH, secure=request.url.scheme == 'https', httponly=True, samesite='lax')
    return response
