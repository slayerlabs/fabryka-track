"""Neptune-style compatibility adapter backed by the Fabryka API."""
from .client import RunClient


class NeptuneRun:
    def __init__(self, client): self._client = client
    def __getitem__(self, path): return self._client[path]
    def __setitem__(self, path, value): self._client[path] = value
    def log(self, metrics, step=None): self._client.log(metrics, step=step)
    def stop(self): self._client.finish()
    def wait(self): return None
    def sync(self): return None
    def __enter__(self): return self
    def __exit__(self, exc_type, exc, tb): self._client.finish("failed" if exc else "finished")


def init_run(*, project=None, api_token=None, name=None, tags=None,
             custom_run_id=None, api_url=None, config=None, **kwargs):
    if not project: raise ValueError("project is required")
    client = RunClient(api_url=api_url, api_key=api_token)
    merged = dict(config or {})
    merged.update(kwargs)
    if tags: merged["tags"] = list(tags)
    experiment = merged.pop("experiment", None)
    client.init(project=project, name=name or custom_run_id or "run",
                config=merged, experiment=experiment)
    return NeptuneRun(client)
