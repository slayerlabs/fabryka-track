"""Public Fabryka SaaS API client.

This package only sends tracking events to a hosted Fabryka API. It never
starts a dashboard or a local server.
"""

from .client import RunClient

run = RunClient()
init = run.init
log = run.log
finish = run.finish

__all__ = ["RunClient", "run", "init", "log", "finish"]
