"""Shared namespace path validation (no server imports)."""
def validate_path(path):
    if not isinstance(path,str) or not path or len(path)>300 or len(path.split('/'))>32 or any(
        segment in ('','.','..') for segment in path.split('/')) or any(ord(c)<32 for c in path):
        raise ValueError('Use a nonempty slash-separated path, up to 300 characters and 32 levels.')
    return path

