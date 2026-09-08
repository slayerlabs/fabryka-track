"""Owner-scoped namespace API. Metadata and series have separate interfaces.

The current adapter is SQL; this does not claim billion-point scalability.
"""
import json
import math
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, literal, select, union_all

from .accounts import owned_run, require_user
from .series_store import SQLSeriesStore
from .database import session_scope
from .models import Artifact, Metric, RunAttribute, RunArtifactLink

router = APIRouter(prefix='/api/runs')


from .paths import validate_path


def checked_path(path):
    try:return validate_path(path)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc


def writable(run):
    if run.metadata_.get('engine')=='tiny-transformer':
        raise HTTPException(409,'Studio training records are managed by the worker. Arbitrary logging is available for SDK runs.')


def set_attribute(session,run,path,value):
    writable(run);checked_path(path)
    try:encoded=json.dumps(value,allow_nan=False)
    except (ValueError,TypeError,RecursionError) as exc:raise HTTPException(422,'Attribute must be finite JSON.') from exc
    if len(encoded.encode())>1_000_000:raise HTTPException(413,'Attribute exceeds 1 MB; upload a file instead.')
    if session.scalar(select(Metric.id).where(Metric.run_id==run.id,(Metric.key==path)|Metric.key.startswith(path+'/',autoescape=True)).limit(1)) or session.scalar(select(RunArtifactLink.path).where(RunArtifactLink.run_id==run.id,(RunArtifactLink.path==path)|RunArtifactLink.path.startswith(path+'/',autoescape=True)).limit(1)):
        raise HTTPException(409,'This subtree contains an append-only series or artifact.')
    leaves=[]
    def flatten(current,value):
        checked_path(current)
        if isinstance(value,dict) and value:
            for key,child in value.items():
                if not isinstance(key,str):raise HTTPException(422,'Object keys must be strings.')
                flatten(current+'/'+key,child)
        else:leaves.append((current,value))
    flatten(path,value)
    if len(leaves)>2000:raise HTTPException(413,'Assign at most 2000 attribute leaves at once.')
    session.execute(delete(RunAttribute).where(RunAttribute.run_id==run.id,(RunAttribute.path==path)|RunAttribute.path.startswith(path+'/',autoescape=True)))
    ancestors=['/'.join(path.split('/')[:i]) for i in range(1,len(path.split('/'))) ]
    if ancestors:session.execute(delete(RunAttribute).where(RunAttribute.run_id==run.id,RunAttribute.path.in_(ancestors)))
    session.add_all(RunAttribute(run_id=run.id,path=key,value=value) for key,value in leaves)


class AttributeInput(BaseModel):
    value: Any


@router.get('/{run_id}/attributes/{path:path}')
def get_attribute(run_id:str,path:str,user=Depends(require_user),session=Depends(session_scope)):
    owned_run(session,run_id,user);checked_path(path)
    exact=session.get(RunAttribute,(run_id,path))
    if exact:return {'path':path,'value':exact.value}
    rows=list(session.scalars(select(RunAttribute).where(RunAttribute.run_id==run_id,RunAttribute.path.startswith(path+'/',autoescape=True)).limit(2001)))
    if not rows:raise HTTPException(404,'Attribute not found')
    if len(rows)>2000:raise HTTPException(413,'Subtree is too large; browse it through the paginated namespace API.')
    value={}
    for row in rows:
        parts=row.path[len(path)+1:].split('/');node=value
        for part in parts[:-1]:node=node.setdefault(part,{})
        node[parts[-1]]=row.value
    return {'path':path,'value':value}


@router.put('/{run_id}/attributes/{path:path}')
def attribute(run_id:str,path:str,body:AttributeInput,user=Depends(require_user),session=Depends(session_scope)):
    run=owned_run(session,run_id,user);set_attribute(session,run,path,body.value);session.commit()
    return {'path':path,'kind':'attribute','value':body.value}


def append_series(session,run,series,timestamp=None):
    writable(run)
    if not isinstance(series,dict) or not series or len(series)>100:raise HTTPException(422,'Submit 1–100 series paths per batch.')
    rows=[];stamp=timestamp or datetime.now(timezone.utc)
    for path,points in series.items():
        checked_path(path)
        if session.get(RunAttribute,(run.id,path)) or session.get(RunArtifactLink,(run.id,path)):
            raise HTTPException(409,'This path already contains an attribute or artifact.')
        if not isinstance(points,list):raise HTTPException(422,'Each series must contain [step, value] pairs.')
        for point in points:
            if not isinstance(point,(list,tuple)) or len(point)!=2:raise HTTPException(422,'Expected [step, value].')
            step,value=point
            if type(step) is not int or not 0<=step<=2**63-1 or isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
                raise HTTPException(422,'Steps must be nonnegative integers and series values finite numbers.')
            rows.append(Metric(run_id=run.id,key=path,step=step,value=float(value),timestamp=stamp))
            if len(rows)>10_000:raise HTTPException(413,'Submit at most 10,000 points per batch.')
    SQLSeriesStore(session).append(rows)
    return len(rows)


@router.post('/{run_id}/series')
def append(run_id:str,body:dict,user=Depends(require_user),session=Depends(session_scope)):
    count=append_series(session,owned_run(session,run_id,user),body);session.commit()
    return {'accepted':count}


@router.get('/{run_id}/series')
def read_series(run_id:str,path:str,after:int=Query(0,ge=0),limit:int=Query(1000,ge=1,le=10_000),
                user=Depends(require_user),session=Depends(session_scope)):
    owned_run(session,run_id,user);checked_path(path)
    rows=SQLSeriesStore(session).read_page(run_id,path,after,limit)
    page=rows[:limit]
    return {'path':path,'points':[{'id':r.id,'step':r.step,'value':r.value,'timestamp':r.timestamp} for r in page],
            'next_cursor':page[-1].id if len(rows)>limit else None}


@router.get('/{run_id}/namespace')
def namespace(run_id:str,prefix:str='',after:str='',limit:int=Query(100,ge=1,le=200),
              user=Depends(require_user),session=Depends(session_scope)):
    run=owned_run(session,run_id,user)
    queries=[select(Metric.key.label('path'),literal('series').label('kind')).where(Metric.run_id==run_id).distinct(),
             select(RunAttribute.path,literal('attribute')).where(RunAttribute.run_id==run_id),
             select(RunArtifactLink.path,literal('artifact')).where(RunArtifactLink.run_id==run_id)]
    entries=union_all(*queries).subquery()
    query=select(entries).where(entries.c.path.startswith(prefix,autoescape=True),entries.c.path>after).order_by(entries.c.path).limit(limit+1)
    rows=session.execute(query).all();items=[]
    for path,kind in rows[:limit]:
        item={'path':path,'kind':kind}
        if kind=='attribute':item['value']=session.get(RunAttribute,(run_id,path)).value
        elif kind=='artifact':
            link=session.get(RunArtifactLink,(run_id,path));a=session.get(Artifact,link.artifact_id)
            item.update(artifact_id=a.id,name=a.name,bytes=a.size)
        items.append(item)
    return {'items':items,'next_cursor':rows[limit-1].path if len(rows)>limit else None,
            'config':run.config if not prefix and not after else None,
            'hardware':run.metadata_ if not prefix and not after else None,
            'storage':{'metadata':'sql','series':'sql','artifacts':'object-storage-or-local'}}
