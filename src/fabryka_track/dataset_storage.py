"""Private file-backed dataset content; legacy small datasets remain in SQL."""
from fastapi.responses import FileResponse, PlainTextResponse
from .settings import settings


def dataset_path(dataset):
    return settings.artifact_dir / 'datasets' / (dataset.id + '.txt')


def content_response(dataset):
    headers = {'ETag': f'"{dataset.sha256}"', 'X-Dataset-SHA256': dataset.sha256}
    if (dataset.source or {}).get('storage') == 'file':
        return FileResponse(dataset_path(dataset), media_type='text/plain; charset=utf-8', headers=headers)
    return PlainTextResponse(dataset.content, headers=headers)


def content_bytes(dataset):
    if (dataset.source or {}).get('storage') == 'file':
        return dataset_path(dataset).read_bytes()
    return dataset.content.encode()
