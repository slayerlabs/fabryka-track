"""Fabryka Track SDK."""

from .client import RunClient

run = RunClient()
init = run.init
log = run.log
finish = run.finish

__all__ = ["run", "init", "log", "finish", "RunClient"]

