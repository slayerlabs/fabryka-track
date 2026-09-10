"""Bounded public Hub imports. Prepare immutable text before renting a GPU."""
import hashlib
import math
import io
import shutil
from uuid import uuid4
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from datasets import get_dataset_config_names, get_dataset_split_names, load_dataset
from fastapi import APIRouter, Depends, HTTPException
from huggingface_hub import HfApi
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select

from .accounts import require_user
from .database import SessionLocal, session_scope
from .models import Dataset, DatasetImport
from .dataset_storage import dataset_path
from .settings import settings

router = APIRouter(prefix='/api/hf-datasets')
LOCK = threading.Lock()
STOP = threading.Event()
POOL = None
ACTIVE = ('queued', 'running')


class Source(BaseModel):
    repo: str = Field(max_length=300)
    revision: str = Field(default='main', min_length=1, max_length=100)
    config: str | None = Field(default=None, max_length=200)
    split: str = Field(default='train', min_length=1, max_length=100)

    @field_validator('repo')
    @classmethod
    def repo_id(cls, value):
        value = value.strip().rstrip('/')
        if value.startswith('https://'):
            url = urlparse(value)
            if url.netloc != 'huggingface.co' or url.query or url.fragment:
                raise ValueError('Use a Hugging Face dataset page or owner/dataset.')
            value = url.path.removeprefix('/datasets/')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', value) or '..' in value:
            raise ValueError('Use owner/dataset or https://huggingface.co/datasets/owner/dataset.')
        return value

    @field_validator('split')
    @classmethod
    def plain_split(cls, value):
        if not re.fullmatch(r'[\w.-]+', value):
            raise ValueError('Select one named split; split expressions are not supported.')
        return value


class Rule(BaseModel):
    column: str = Field(min_length=1, max_length=100)
    operator: str = Field(pattern=r'^(equals|contains|gte|lte)$')
    value: str = Field(min_length=1, max_length=300)

    @model_validator(mode='after')
    def numeric(self):
        if self.operator in ('gte', 'lte'):
            try:
                if not math.isfinite(float(self.value)): raise ValueError()
            except ValueError:
                raise ValueError('Numeric filters need a finite number.')
        return self


class ImportSpec(Source):
    text_column: str = Field(default='text', min_length=1, max_length=100)
    max_mb: int = Field(default=100, ge=1, le=5000)
    min_chars: int = Field(default=100, ge=1, le=100000)
    max_chars: int = Field(default=100000, ge=100, le=250000)
    contains: str = Field(default='', max_length=300)
    excludes: str = Field(default='', max_length=300)
    deduplicate: bool = True
    rules: list[Rule] = Field(default_factory=list, max_length=5)

    @model_validator(mode='after')
    def lengths(self):
        if self.min_chars > self.max_chars: raise ValueError('Minimum length exceeds maximum length.')
        return self


def pin(source):
    # Explicit False prevents use of any server-side cached HF credential.
    info = HfApi(token=False).dataset_info(source.repo, revision=source.revision, timeout=20)
    if info.private or info.gated:
        raise ValueError('Only public, ungated datasets are supported. No Hugging Face connection is needed.')
    # Hub cards may point a built-in loader at arbitrary external URLs. This
    # importer accepts repository-local data only, never an external data host.
    card = info.card_data.to_dict() if getattr(info, 'card_data', None) else {}
    def local_paths(value):
        if isinstance(value, str):
            if '://' in value or value.startswith(('/', '~')) or '..' in value.split('/'):
                raise ValueError('Datasets referencing external or absolute data paths are not supported.')
        elif isinstance(value, list):
            for item in value: local_paths(item)
        elif isinstance(value, dict):
            for item in value.values(): local_paths(item)
    for config in card.get('configs') or []:
        for key in ('data_files', 'data_dir'):
            if key in config: local_paths(config[key])
    return source.model_copy(update={'revision': info.sha})


def stream(source):
    rows = load_dataset(source.repo, name=source.config, split=source.split,
                        revision=source.revision, streaming=True, token=False)
    if source.repo == 'nvidia/Nemotron-ClimbMix':
        import tiktoken
        encoding = tiktoken.get_encoding('gpt2')
        def decode(row):
            tokens = row.get('tokens')
            if not isinstance(tokens, list) or any(type(t) is not int or not 0 <= t < encoding.n_vocab for t in tokens):
                raise ValueError('ClimbMix contains an invalid GPT-2 token sequence.')
            return {**row, 'text': encoding.decode(tokens, errors='strict')}
        rows = rows.map(decode)
    return rows


def public_error(exc):
    if isinstance(exc, ValueError): return str(exc)[:500]
    return 'Could not read this public dataset. Check its subset, split and format, then retry. Private, gated and custom-script datasets are not supported.'


@router.post('/inspect')
def inspect_source(body: Source, user=Depends(require_user)):
    try:
        source = pin(body)
        configs = get_dataset_config_names(source.repo, revision=source.revision, token=False)
        config = source.config or ('default' if 'default' in configs else configs[0])
        if config not in configs: raise ValueError('Select a listed subset.')
        splits = get_dataset_split_names(source.repo, config_name=config, revision=source.revision, token=False)
        split = source.split if source.split in splits else ('train' if 'train' in splits else splits[0])
        source = source.model_copy(update={'config': config, 'split': split})
        rows = list(stream(source).take(3))
        if not rows: raise ValueError('This split contains no rows.')
        columns = [{'name': k, 'text': isinstance(v, str)} for k, v in rows[0].items()]
        return {**source.model_dump(), 'configs': configs, 'splits': splits, 'columns': columns,
                'samples': [{k: str(v)[:800] for k,v in r.items()} for r in rows],
                'notice': ('English · CC BY-NC 4.0 · research/non-commercial use. GPT-2 tokens are decoded to text for Track’s byte trainer. A bounded prefix may cover only a few topic clusters.' if source.repo == 'nvidia/Nemotron-ClimbMix' else '')}
    except Exception as exc:
        raise HTTPException(422, public_error(exc)) from exc


def matches(row, spec):
    text = row.get(spec.text_column)
    if not isinstance(text, str): return None
    text = text.strip().replace('\r\n', '\n').replace('\r', '\n')
    if '\x00' in text or not spec.min_chars <= len(text) <= spec.max_chars: return None
    lower = text.casefold()
    if spec.contains and spec.contains.casefold() not in lower: return None
    if spec.excludes and spec.excludes.casefold() in lower: return None
    for rule in spec.rules:
        value = row.get(rule.column)
        if value is None or isinstance(value, (list, dict)): return None
        if rule.operator == 'equals' and str(value).casefold() != rule.value.casefold(): return None
        if rule.operator == 'contains' and rule.value.casefold() not in str(value).casefold(): return None
        if rule.operator in ('gte', 'lte'):
            try: number = float(value)
            except (TypeError, ValueError): return None
            if not math.isfinite(number): return None
            if rule.operator == 'gte' and number < float(rule.value): return None
            if rule.operator == 'lte' and number > float(rule.value): return None
    # The byte trainer uses blank lines as document boundaries. Preserve one
    # boundary per source row by collapsing internal empty lines.
    return re.sub(r'\n(?:[ \t]*\n)+', '\n', text)


def collect(rows, spec, row_limit=20000000, seconds=21600, progress=None, stop_event=None, output=None):
    start = time.monotonic()
    sink, seen = output if output is not None else io.BytesIO(), set()
    stats = {'scanned': 0, 'accepted': 0, 'duplicates': 0, 'bytes': 0, 'stop_reason': 'source_exhausted'}
    columns_checked = False
    for row in rows:
        if stop_event is not None and stop_event.is_set(): raise ValueError('Import interrupted by a server restart. Please retry.')
        if stats['scanned'] >= row_limit or time.monotonic()-start >= seconds:
            stats['stop_reason'] = 'scan_limit' if stats['scanned'] >= row_limit else 'time_limit'
            break
        if not columns_checked:
            missing = {spec.text_column, *(r.column for r in spec.rules)} - row.keys()
            if missing: raise ValueError('Unknown columns: '+', '.join(sorted(missing)))
            columns_checked = True
        stats['scanned'] += 1
        text = matches(row, spec)
        if text:
            raw = text.encode('utf-8')
            digest = hashlib.sha256(raw).digest()
            if spec.deduplicate and digest in seen:
                stats['duplicates'] += 1
            else:
                size = len(raw)+(2 if stats['accepted'] else 0)
                if stats['bytes']+size > spec.max_mb*1000000:
                    stats['stop_reason'] = 'size_limit'; break
                if stats['accepted']: sink.write(b'\n\n')
                sink.write(raw)
                if spec.deduplicate: seen.add(digest)
                stats['bytes'] += size; stats['accepted'] += 1
        if progress and stats['scanned'] % 250 == 0: progress(dict(stats))
    return (sink.getvalue().decode('utf-8') if output is None else None), stats


@router.post('/preview')
def preview(body: ImportSpec, user=Depends(require_user)):
    try:
        source = pin(body)
        content, stats = collect(stream(source), source, row_limit=200, seconds=30)
        return {'revision': source.revision, 'stats': stats,
                'samples': [x[:1200] for x in content.split('\n\n')[:5]] if content else []}
    except Exception as exc:
        raise HTTPException(422, public_error(exc)) from exc


def serialize(job):
    return {'id': job.id, 'state': job.state, 'config': job.config,
            'progress': job.progress, 'dataset_id': job.dataset_id, 'error': job.error}


@router.get('/imports')
def imports(user=Depends(require_user), session=Depends(session_scope)):
    return [serialize(j) for j in session.scalars(select(DatasetImport).where(
        DatasetImport.owner_id == user.id).order_by(DatasetImport.created_at.desc()).limit(10))]


@router.post('/imports', status_code=202)
def start_import(body: ImportSpec, user=Depends(require_user), session=Depends(session_scope)):
    if POOL is None: raise HTTPException(503, 'Dataset importer is unavailable.')
    try: body = pin(body)
    except Exception as exc: raise HTTPException(422, public_error(exc)) from exc
    with LOCK:
        active = session.scalars(select(DatasetImport).where(DatasetImport.state.in_(ACTIVE))).all()
        if len(active) >= 2 or any(j.owner_id == user.id for j in active):
            raise HTTPException(409, 'An import is already active. Wait for it to finish, then retry.')
        job = DatasetImport(owner_id=user.id, config=body.model_dump())
        session.add(job); session.commit()
        POOL.submit(run_import, job.id)
        return serialize(job)


def run_import(job_id):
    temporary = None
    final_path = None
    try:
        with SessionLocal() as db:
            job = db.get(DatasetImport, job_id)
            job.state = 'running'; db.commit()
            spec = ImportSpec(**job.config)
        last_update = time.monotonic()
        def update(stats):
            nonlocal last_update
            if time.monotonic()-last_update < 1: return
            with SessionLocal() as db:
                job = db.get(DatasetImport, job_id); job.progress = stats; db.commit()
            last_update = time.monotonic()
        folder = settings.artifact_dir / 'datasets'
        folder.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(folder).free < spec.max_mb * 1000000 + 2000000000:
            raise ValueError('Not enough storage for this import. Choose a smaller size.')
        temporary = folder / (job_id + '.partial')
        with temporary.open('wb') as output:
            _, stats = collect(stream(spec), spec, progress=update, stop_event=STOP, output=output)
        digest = hashlib.sha256()
        with temporary.open('rb') as content_file:
            for chunk in iter(lambda: content_file.read(1024*1024), b''): digest.update(chunk)
        with SessionLocal() as db:
            job = db.get(DatasetImport, job_id); job.progress = stats; db.commit()
        if stats['accepted'] < 2 or stats['bytes'] < 4096:
            raise ValueError('Too little matching text for training. Import at least two documents and 4 KB; relax the filters or choose another split.')
        with SessionLocal() as db:
            job = db.get(DatasetImport, job_id)
            source = {**spec.model_dump(), 'kind': 'huggingface', 'storage': 'file', 'stats': stats,
                      'decoder': 'tiktoken:gpt2' if spec.repo == 'nvidia/Nemotron-ClimbMix' else None,
                      'sampling': 'First matching whole documents in source order; bounded sample, not representative.',
                      'normalization': 'Trim text, normalize newlines, collapse internal blank lines.'}
            dataset = Dataset(id=str(uuid4()), owner_id=job.owner_id, name=f'{spec.repo} · {spec.config or "default"}/{spec.split}'[:200],
                              content='', byte_count=stats['bytes'], source=source,
                              sha256=digest.hexdigest(), example=False)
            final_path = dataset_path(dataset)
            temporary.replace(final_path)
            db.add(dataset); db.flush()
            job.dataset_id = dataset.id; job.progress = stats; job.state = 'finished'; db.commit()
    except Exception as exc:
        if temporary: temporary.unlink(missing_ok=True)
        if final_path: final_path.unlink(missing_ok=True)
        with SessionLocal() as db:
            job = db.get(DatasetImport, job_id)
            if job:
                job.state = 'failed'; job.error = public_error(exc); db.commit()


def start_importer():
    global POOL
    STOP.clear()
    with SessionLocal() as db:
        for job in db.scalars(select(DatasetImport).where(DatasetImport.state.in_(ACTIVE))):
            job.state = 'failed'; job.error = 'Import interrupted by a server restart. Please retry.'
            (settings.artifact_dir / 'datasets' / (job.id + '.partial')).unlink(missing_ok=True)
        db.commit()
    POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix='hf-import')


def stop_importer():
    global POOL
    STOP.set()
    if POOL: POOL.shutdown(wait=True, cancel_futures=True)
    POOL = None
