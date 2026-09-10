"""Disk-based whole-document holdout for the standalone GPU worker."""
import hashlib
from pathlib import Path


def documents(path):
    pending = b''
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            parts = (pending + chunk).split(b'\n\n')
            pending = parts.pop()
            for part in parts:
                if part.strip(): yield part
        if pending.strip(): yield pending


def split_files(source, train_path, val_path, seed, seen):
    """Same ranked content-hash split as the byte trainer, without retaining text."""
    unique = set()
    for document in documents(source):
        digest = hashlib.sha256(document).hexdigest()
        if digest not in seen: unique.add(digest)
    if len(unique) < 2:
        # Preserve the existing small/single-document fallback.
        cut = int(Path(source).stat().st_size * .9)
        with Path(source).open('rb') as src, Path(train_path).open('wb') as train, Path(val_path).open('wb') as val:
            remaining = cut
            while remaining:
                chunk = src.read(min(remaining, 1024 * 1024))
                if not chunk: break
                train.write(chunk); remaining -= len(chunk)
            for chunk in iter(lambda: src.read(1024 * 1024), b''): val.write(chunk)
        return
    ordered = sorted(unique, key=lambda digest: hashlib.sha256(f'{seed}:{digest}'.encode()).hexdigest())
    holdout = set(ordered[:max(1, len(ordered) // 10)])
    del ordered, unique
    with Path(train_path).open('wb') as train, Path(val_path).open('wb') as val:
        for document in documents(source):
            digest = hashlib.sha256(document).hexdigest()
            if digest in seen: continue
            seen.add(digest)
            target = val if digest in holdout else train
            if target.tell(): target.write(b'\n\n')
            target.write(document)
