"""Owner-authorized, one-run exports into SlayerLab using a transient OAuth token."""
import logging
from .provider_diagnostics import response_details

logger = logging.getLogger(__name__)

import hashlib
import inspect
import json
import re
import tempfile
import threading
from pathlib import Path
from typing import Literal

import torch
from fastapi.responses import RedirectResponse
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import HfHubHTTPError
from pydantic import BaseModel, Field, field_validator
from safetensors.torch import save_file
from sqlalchemy import delete, select

from .accounts import COOKIE, owned_run, require_user, throttle
from .database import SessionLocal, session_scope
from .models import Account, Artifact, HFPublication, HuggingFaceIdentity, OAuthAttempt, Run
from .settings import settings

router = APIRouter(prefix='/api/training')
ORG = 'SlayerLab'
FILES = ['model.safetensors', 'config.json', 'training.json', 'modeling_fabryka.py',
         'generate.py', 'requirements.txt', 'README.md', 'export.json']
lock = threading.Lock()


def describe(publication):
    if not publication:
        return None
    return {'repo_id': publication.repo_id, 'private': publication.private,
            'status': publication.status, 'error': publication.error, 'commit': publication.commit,
            'url': 'https://huggingface.co/' + publication.repo_id if publication.status == 'finished' else None}


def checkpoint_path(session, run):
    if run.state != 'finished' or run.metadata_.get('engine') != 'tiny-transformer':
        raise HTTPException(409, 'Finish a studio training run before publishing.')
    artifact = session.scalar(select(Artifact).where(Artifact.run_id == run.id, Artifact.name == 'model.pt'))
    if not artifact:
        raise HTTPException(409, 'The model checkpoint is missing.')
    path = (settings.artifact_dir / artifact.storage_key).resolve()
    if not path.is_relative_to(settings.artifact_dir.resolve()) or not path.is_file():
        raise HTTPException(409, 'The model checkpoint is unavailable on this server.')
    return path


@router.get('/{run_id}/huggingface')
def preview(run_id: str, user=Depends(require_user), session=Depends(session_scope)):
    run = owned_run(session, run_id, user)
    checkpoint_path(session, run)
    identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
    slug = re.sub(r'[^a-z0-9]+', '-', run.name.lower()).strip('-')[:50] or 'model'
    return {'organization': ORG, 'suggested_name': slug + '-' + run.id[:8], 'files': FILES,
            'hf_username': identity.username if identity else None,
            'publication': describe(session.get(HFPublication, run.id))}


class PublishInput(BaseModel):
    repo_name: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$')
    private: bool = True
    confirm: Literal[True]

    @field_validator('repo_name')
    @classmethod
    def validate_repo(cls, value):
        if '..' in value or '--' in value or value.endswith(('.git', '.ipynb')):
            raise ValueError('Choose a simple repository name without consecutive dots or hyphens.')
        return value


@router.post('/{run_id}/huggingface')
def prepare(run_id: str, body: PublishInput, request: Request, response: Response,
            user=Depends(require_user), session=Depends(session_scope)):
    from .huggingface_auth import begin_oauth
    if not request.cookies.get(COOKIE) or request.headers.get('authorization'):
        raise HTTPException(401, 'Use your signed-in browser to authorize a Hugging Face export.')
    throttle(request)
    run = owned_run(session, run_id, user)
    checkpoint_path(session, run)
    identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == user.id))
    if not identity:
        raise HTTPException(409, 'Connect Hugging Face in Account before publishing.')
    with lock:
        publication = session.get(HFPublication, run.id)
        if publication and publication.status in ('uploading', 'finished'):
            raise HTTPException(409, 'This run is already uploading or has been published.')
        repo_id = ORG + '/' + body.repo_name
        other = session.scalar(select(HFPublication).where(HFPublication.repo_id == repo_id))
        if other and other.run_id != run.id:
            raise HTTPException(409, 'That repository name is already used by another run.')
        if publication:
            if publication.oauth_state:
                session.execute(delete(OAuthAttempt).where(OAuthAttempt.id == publication.oauth_state))
            if publication.repo_created and (publication.repo_id != repo_id or publication.private != body.private):
                raise HTTPException(409, 'Retry this export with its original repository name and visibility.')
            publication.repo_id, publication.private = repo_id, body.private
            publication.status, publication.error = 'authorizing', None
        else:
            publication = HFPublication(run_id=run.id, owner_id=user.id, repo_id=repo_id, private=body.private)
            session.add(publication)
        url, state_hash = begin_oauth(request, response, session, user.id,
                                     'openid profile contribute-repos read-memberships',
                                     org_ids='6a2d1122dd2a510a8513fe63')
        publication.oauth_state = state_hash
        session.commit()
    return {'url': url}


def authorized_upload(publication, request, code, verifier, session, background_tasks):
    from .huggingface_auth import fetch_grant, failure, FLOW_COOKIE, FLOW_PATH
    try:
        profile, token = fetch_grant(code, verifier)
        identity = session.scalar(select(HuggingFaceIdentity).where(HuggingFaceIdentity.account_id == publication.owner_id))
        if not identity or identity.subject != profile['sub']:
            raise ValueError('Wrong Hugging Face account')
        checkpoint_path(session, owned_run(session, publication.run_id, session.get(Account, publication.owner_id)))
    except Exception:
        publication.status, publication.error = 'failed', 'Authorize with the HF account connected to your Track account, then try again.'
        session.commit()
        return failure(request, publication.error)
    try:
        info = HfApi(token=token).whoami()
        org = next((o for o in info.get('orgs', []) if o.get('name', '').lower() == ORG.lower()), None)
        if not org or org.get('roleInOrg') not in ('contributor', 'write', 'admin'):
            publication.status = 'failed'
            publication.error = 'Publishing requires a SlayerLab contributor, write or admin role. Ask a SlayerLab admin to grant access, then authorize SlayerLab and retry. Your trained checkpoint is safe.'
            session.commit()
            logger.warning("hf_publish_preflight_denied run=%s reason=organization_role", publication.run_id)
            return failure(request, publication.error)
    except Exception as exc:
        response = getattr(exc, "response", None)
        logger.warning("hf_publish_preflight_failed run=%s exception=%s details=%s", publication.run_id, type(exc).__name__,
                       response_details(response, [token]) if response is not None else "no_response")
        publication.status, publication.error = 'failed', 'Could not verify SlayerLab publishing access. Reauthorize and retry. Your trained checkpoint is safe.'
        session.commit()
        return failure(request, publication.error)
    publication.status, publication.error = 'uploading', None
    session.commit()
    background_tasks.add_task(upload, publication.run_id, token)
    response = RedirectResponse('/#run/' + publication.run_id, status_code=303)
    response.delete_cookie(FLOW_COOKIE, path=FLOW_PATH, secure=request.url.scheme == 'https', httponly=True, samesite='lax')
    return response


GENERATE = '''import argparse
import json
from pathlib import Path
import torch
from safetensors.torch import load_file
from modeling_fabryka import TinyTransformer

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default="The morning")
    parser.add_argument("--tokens", type=int, default=100)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    cfg = json.loads((root / "config.json").read_text())
    model = TinyTransformer(**cfg["architecture"]).eval()
    model.load_state_dict(load_file(str(root / "model.safetensors")))
    tokens = list(args.prompt.encode("utf-8")) or [32]
    with torch.no_grad():
        for _ in range(max(0, args.tokens)):
            x = torch.tensor([tokens[-cfg["architecture"]["context_length"]:]], dtype=torch.long)
            probabilities = torch.softmax(model(x)[0, -1], dim=-1)
            tokens.append(torch.multinomial(probabilities, 1).item())
    print(bytes(tokens).decode("utf-8", errors="replace"))
'''


def build_export(run, checkpoint, folder):
    from .training import TinyTransformer
    payload = torch.load(checkpoint, map_location='cpu', weights_only=True)
    cfg = payload['config']
    architecture = {k: cfg[k] for k in ('width', 'layers', 'heads', 'context_length')}
    model = TinyTransformer(**architecture)
    model.load_state_dict(payload['state_dict'], strict=True)
    save_file({k: v.detach().cpu().contiguous() for k, v in model.state_dict().items()}, str(folder / 'model.safetensors'))
    (folder / 'config.json').write_text(json.dumps({'format': 'fabryka-byte-transformer-v1',
        'architecture': architecture, 'tokenizer': 'utf8-byte', 'vocab_size': 256}, indent=2))
    training = {k: cfg.get(k) for k in ('steps', 'batch_size', 'learning_rate', 'seed', 'validation_split',
        'budget_mode', 'early_stopping', 'parameters', 'planned_training_tokens')}
    training['data_mix'] = [{'source': d['name'] if d.get('example') else 'Private source ' + str(i+1),
                             'weight': d['weight']} for i, d in enumerate(cfg.get('mix', []))]
    result = run.metadata_.get('training_result', {})
    training['result'] = {k: result.get(k) for k in ('best_step', 'best_val_loss', 'best_val_perplexity', 'completed_steps', 'tokens_seen', 'stop_reason')}
    training['checkpoint_selection'] = 'lowest_validation_loss' if payload.get('best_step') is not None else 'legacy_final_checkpoint'
    (folder / 'training.json').write_text(json.dumps(training, indent=2))
    (folder / 'modeling_fabryka.py').write_text('import torch\nfrom torch import nn\n\n' + inspect.getsource(TinyTransformer))
    (folder / 'generate.py').write_text(GENERATE)
    (folder / 'requirements.txt').write_text('torch>=2.4\nsafetensors>=0.4\n')
    parameters = sum(p.numel() for p in model.parameters())
    card = f'''---
tags:
- slayerlab
- fabryka-track
- pytorch
- byte-level
- text-generation
---
# SlayerLab byte-level transformer

Published from Fabryka Track by the run owner into SlayerLab.
A {parameters:,}-parameter causal transformer trained from scratch on UTF-8 bytes.
The exported weights use checkpoint selection: {training['checkpoint_selection']}.
See `training.json` for the recorded training settings and validation results.

## Run locally

Download this repository, then run:

```bash
pip install -r requirements.txt
python generate.py --prompt "The morning" --tokens 100
```

This uses the included PyTorch implementation, not Transformers AutoModel.
The tokenizer maps each UTF-8 byte to an integer in 0–255; there are no special tokens.

## Data and limitations

Uploaded source text, private filenames, dataset hashes, notes and logs are excluded.
Only source mixture proportions and training settings are included.
This small model is a training experiment. Repeated data may cause memorization;
validation uses a small held-out sample and is not a general capability benchmark.
The model is not instruction-tuned and may produce invalid UTF-8 or incoherent text.
No model or dataset license is asserted by this automated export.
'''
    (folder / 'README.md').write_text(card)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()}
    (folder / 'export.json').write_text(json.dumps({'sha256': hashes}, indent=2))
    hashes['export.json'] = hashlib.sha256((folder / 'export.json').read_bytes()).hexdigest()
    return hashes


def upload(run_id, token):
    stage = 'prepare_export'
    try:
        with SessionLocal() as session:
            publication = session.get(HFPublication, run_id)
            run = session.get(Run, run_id)
            if not run or run.owner_id != publication.owner_id:
                raise ValueError('Run ownership changed')
            path = checkpoint_path(session, run)
            repo_id, private, created = publication.repo_id, publication.private, publication.repo_created
            if publication.status != 'uploading':
                return
            with tempfile.TemporaryDirectory(prefix='track-hf-') as temp:
                folder = Path(temp) / 'export'
                folder.mkdir()
                hashes = build_export(run, path, folder)
                api = HfApi(token=token)
                if not created:
                    stage = 'create_repository'
                    api.create_repo(repo_id=repo_id, repo_type='model', private=private, exist_ok=False)
                    publication.repo_created = True
                    session.commit()
                stage = 'upload_files'
                commit = api.upload_folder(repo_id=repo_id, repo_type='model', folder_path=str(folder),
                                           commit_message='Publish Fabryka Track checkpoint')
                # Completion means the actual committed bytes have been downloaded and checked.
                stage = 'verify_files'
                for filename, expected in hashes.items():
                    downloaded = hf_hub_download(repo_id=repo_id, filename=filename, revision=commit.oid,
                                                  token=token, local_dir=str(Path(temp) / 'verify'))
                    if hashlib.sha256(Path(downloaded).read_bytes()).hexdigest() != expected:
                        raise ValueError('Remote file verification failed')
                publication.status, publication.commit, publication.error = 'finished', commit.oid, None
                session.commit()
    except Exception as exc:
        response = getattr(exc, 'response', None)
        logger.warning("hf_publish_failed run=%s stage=%s exception=%s details=%s", run_id, stage, type(exc).__name__,
                       response_details(response, [token]) if response is not None else 'no_response')
        message = 'Upload or file verification failed. Reauthorize to retry.'
        if isinstance(exc, HfHubHTTPError):
            code = exc.response.status_code if exc.response is not None else None
            if code in (401, 403):
                message = f'Hugging Face denied access during {stage.replace("_", " ")} (HTTP {code}). Grant Track access to SlayerLab and ensure your HF account has contributor, write or admin permission. Reauthorize to retry. Your trained checkpoint is safe.'
            elif code == 409:
                message = 'This repository already exists. Choose a new name; Track will not overwrite an existing model.'
        with SessionLocal() as session:
            publication = session.get(HFPublication, run_id)
            if publication:
                publication.status, publication.error = 'failed', message
                session.commit()


def recover_uploads():
    with SessionLocal() as session:
        for publication in session.scalars(select(HFPublication).where(HFPublication.status == 'uploading')):
            publication.status = 'failed'
            publication.error = 'The server restarted during upload. Reauthorize to retry.'
        session.commit()
