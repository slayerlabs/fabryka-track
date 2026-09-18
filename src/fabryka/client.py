"""Small, dependency-light client for the hosted Fabryka tracker."""
import atexit
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx


def _command(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=2,
                              check=False).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


class RunClient:
    """Non-blocking hosted tracking client; it never starts a dashboard."""

    def __init__(self, api_url=None, api_key=None, spool_dir=None):
        self.api_url = (api_url or os.getenv("FABRYKA_API_URL", "https://track.fabryka.ai")).rstrip("/")
        self.api_key = api_key or os.getenv("FABRYKA_API_KEY")
        self.spool_dir = Path(spool_dir or os.getenv("FABRYKA_SPOOL_DIR", "~/.fabryka/spool")).expanduser()
        self.run_id = None
        self._queue = queue.Queue()
        self._stop = threading.Event()
        self._worker = None
        self._last_step = -1

    def init(self, project, name, config=None, experiment=None, note="", api_url=None):
        if self.run_id:
            raise RuntimeError("A run is already active; call run.finish() first")
        if api_url:
            self.api_url = api_url.rstrip("/")
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        self.run_id = str(uuid.uuid4())
        metadata = {"hostname": socket.gethostname(), "python": sys.version.split()[0],
                    "command": " ".join(sys.argv), "started_at": datetime.now(timezone.utc).isoformat()}
        if os.getenv("FABRYKA_PUBLIC_LIVE_TRACKING") == "1":
            metadata["public_live_tracking"] = True
        commit = _command("git", "rev-parse", "HEAD")
        if commit: metadata["git_commit"] = commit
        if experiment: metadata["experiment"] = experiment
        self._emit("run.init", {"run_id": self.run_id, "project": project, "name": name,
                                 "config": config or {}, "metadata": metadata, "note": note})
        self._worker = threading.Thread(target=self._upload_loop, daemon=True, name="fabryka-sdk-uploader")
        self._worker.start()
        atexit.register(self._atexit)
        return self

    def log(self, metrics, step=None):
        if not self.run_id: raise RuntimeError("Call run.init() before run.log()")
        if step is None: step = self._last_step + 1
        self._last_step = max(self._last_step, step)
        self._emit("run.metrics", {"run_id": self.run_id, "step": step,
                                    "metrics": {str(k): float(v) for k, v in metrics.items()}})

    def __getitem__(self, path):
        return RunField(self, path)

    def __setitem__(self, path, value):
        if not self.run_id: raise RuntimeError("Call run.init() before assigning fields")
        self._emit("run.attribute", {"run_id": self.run_id, "path": str(path), "value": value})

    def log_text(self, message, level="info"):
        if not self.run_id: raise RuntimeError("No active run")
        self._emit("run.log", {"run_id": self.run_id, "message": message, "level": level})

    def artifact(self, path, namespace=None):
        if not self.run_id: raise RuntimeError("No active run")
        source = Path(path)
        target = self.spool_dir / "artifacts" / self.run_id / f"{uuid.uuid4()}-{source.name}"
        target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target)
        self._emit("run.artifact", {"run_id": self.run_id, "name": source.name,
                                     "local_path": str(target), "namespace": namespace})

    def finish(self, state="finished", timeout=5):
        if not self.run_id: return
        self._emit("run.finish", {"run_id": self.run_id, "state": state})
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline: time.sleep(.05)
        self._stop.set()
        if self._worker: self._worker.join(timeout=1)
        self.run_id = None

    def _emit(self, kind, payload):
        event = {"id": str(uuid.uuid4()), "type": kind,
                 "timestamp": datetime.now(timezone.utc).isoformat(), "payload": payload}
        path = self.spool_dir / f"{time.time_ns()}-{event['id']}.jsonl"
        path.write_text(json.dumps(event, separators=(",", ":")) + "\n")
        self._queue.put(path)

    def _upload_loop(self):
        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        while not self._stop.is_set() or not self._queue.empty():
            try: path = self._queue.get(timeout=.25)
            except queue.Empty: continue
            try:
                event = json.loads(path.read_text())
                if event["type"] == "run.artifact":
                    item = event["payload"]
                    with open(item["local_path"], "rb") as handle:
                        r = httpx.post(f"{self.api_url}/api/runs/{item['run_id']}/artifacts",
                                       files={"file": (item["name"], handle)}, headers=headers, timeout=30)
                    Path(item["local_path"]).unlink(missing_ok=True)
                else:
                    r = httpx.post(f"{self.api_url}/api/events", json={"events": [event]},
                                   headers=headers, timeout=10)
                r.raise_for_status(); path.unlink(missing_ok=True)
            except Exception:
                if not self._stop.wait(1): self._queue.put(path)
            finally: self._queue.task_done()

    def _atexit(self):
        if self.run_id: self.finish(state="failed", timeout=1)


class RunField:
    def __init__(self, run, path): self.run, self.path = run, str(path)
    def append(self, value, step=None): self.run.log({self.path: value}, step=step)
    def upload(self, path): self.run.artifact(path, namespace=self.path)
