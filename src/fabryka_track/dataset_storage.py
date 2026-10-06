"""Private file-backed dataset content; legacy small datasets remain in SQL."""
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi import HTTPException
from .settings import settings


def dataset_path(dataset):
    return settings.artifact_dir / 'datasets' / (dataset.id + '.txt')


def require_dataset_storage():
    if not settings.dataset_storage_enabled:
        raise HTTPException(503, 'Dataset storage is disabled on this tracking server. Prepare training data on your training infrastructure.')


def require_dataset_content(dataset):
    source = dataset.source or {}
    if source.get('content_available') is False or (source.get('storage') == 'file' and not dataset_path(dataset).is_file()):
        raise HTTPException(410, 'Dataset content is no longer stored on this tracking server. Its source metadata and experiment history are retained.')


def content_response(dataset):
    require_dataset_content(dataset)
    headers = {'ETag': f'"{dataset.sha256}"', 'X-Dataset-SHA256': dataset.sha256}
    if (dataset.source or {}).get('storage') == 'file':
        return FileResponse(dataset_path(dataset), media_type='text/plain; charset=utf-8', headers=headers)
    return PlainTextResponse(dataset.content, headers=headers)


def content_bytes(dataset):
    require_dataset_content(dataset)
    if (dataset.source or {}).get('storage') == 'file':
        return dataset_path(dataset).read_bytes()
    return dataset.content.encode()
