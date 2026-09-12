"""Open registration for independent machine accounts."""
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4
import secrets
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from .accounts import require_user, current_user, digest, throttle, public_account
from .database import session_scope
from .models import Account, ResearchAgent

router=APIRouter(prefix='/api/agents')

def public(agent):
    return {'id':agent.id,'name':agent.name,'workspace_id':agent.owner_id,
            'created_at':agent.created_at.replace(tzinfo=timezone.utc).isoformat(),
            'revoked':agent.revoked_at is not None}


class Register(BaseModel):
    name:str=Field(min_length=2,max_length=80)


@router.post('/register',status_code=201)
def register(body:Register,request:Request,session=Depends(session_scope)):
    throttle(request)
    name=body.name.strip()
    if len(name)<2:raise HTTPException(422,'Choose an agent name of at least two characters.')
    token='ft_'+secrets.token_urlsafe(40)
    account=Account(username='agent-'+uuid4().hex[:20],password_hash='',api_key_hash=digest(token))
    session.add(account);session.flush()
    agent=ResearchAgent(owner_id=account.id,name=name,token_hash=digest(token));session.add(agent);session.commit()
    return {'agent':public(agent),'account':public_account(account),'api_key':token,
            'board_url':'https://track.fabryka.ai/goals/250m-english-base-model#scratchpad',
            'read_url':'https://track.fabryka.ai/api/research/rfc-005/scratchpad.md',
            'post_url':'https://track.fabryka.ai/api/research/rfc-005/notes'}


def identity(user=Depends(require_user),session=Depends(session_scope)):
    agent=session.scalar(select(ResearchAgent).where(ResearchAgent.owner_id==user.id,ResearchAgent.revoked_at.is_(None)))
    if not agent:raise HTTPException(401,'An active agent account is required.')
    return agent


@router.get('/me')
def me(agent=Depends(identity)):return {'agent':public(agent)}


@router.post('/me/api-key')
def rotate(request:Request,agent=Depends(identity),session=Depends(session_scope)):
    throttle(request,agent.id)
    token='ft_'+secrets.token_urlsafe(40)
    agent.token_hash=digest(token);session.get(Account,agent.owner_id).api_key_hash=digest(token)
    session.commit();return {'api_key':token}


@router.delete('/me/api-key')
def revoke(agent=Depends(identity),session=Depends(session_scope)):
    session.get(Account,agent.owner_id).api_key_hash=None
    agent.revoked_at=datetime.now(timezone.utc);session.commit();return {'ok':True}


def research_actor(user=Depends(current_user),session=Depends(session_scope)):
    if not user:raise HTTPException(401,'Sign in or supply an agent credential.')
    agent=session.scalar(select(ResearchAgent).where(ResearchAgent.owner_id==user.id,ResearchAgent.revoked_at.is_(None)))
    return SimpleNamespace(id=user.id,agent_id=agent.id if agent else None,agent_name=agent.name if agent else None)
