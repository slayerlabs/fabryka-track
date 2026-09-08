import atexit
import json
import os
import platform
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
from typing import Any

import httpx

from .settings import settings


def _command(*args: str) -> str | None:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=2, check=False).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _metadata() -> dict:
    commit = _command("git", "rev-parse", "HEAD")
    dirty = bool(_command("git", "status", "--porcelain")) if commit else None
    gpu_lines = (_command("nvidia-smi", "--query-gpu=name", "--format=csv,noheader") or "").splitlines()
    cuda = _command("nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits")
    try:
        import torch
        torch_version, torch_cuda = torch.__version__, torch.version.cuda
    except ImportError:
        torch_version = torch_cuda = None
    return {
        "git_commit": commit, "git_dirty": dirty, "hostname": socket.gethostname(),
        "gpu_models": gpu_lines, "gpu_count": len(gpu_lines), "cuda_driver": cuda,
        "cuda": torch_cuda, "pytorch": torch_version, "python": platform.python_version(),
        "command": " ".join(sys.argv), "pid": os.getpid(),
    }


class RunClient:
    """Process-global run client. Public calls are non-blocking after local persistence."""

    def __init__(self, api_url: str | None = None, spool_dir: str | Path | None = None):
        self.api_key = settings.api_key
        self.api_url = (api_url or settings.api_url).rstrip("/")
        self.spool_dir = Path(spool_dir or settings.spool_dir)
        self.run_id: str | None = None
        self._queue: queue.Queue[Path] = queue.Queue()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._system_worker: threading.Thread | None = None
        self._last_step = -1
        self._lock = threading.Lock()

    def init(self, project: str, name: str, config: dict | None = None, experiment: str | None = None,
             note: str = "", api_url: str | None = None) -> "RunClient":
        if self.run_id:
            raise RuntimeError("A run is already active; call run.finish() first")
        if api_url:
            self.api_url = api_url.rstrip("/")
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        self.run_id = str(uuid.uuid4())
        self._stop.clear()
        self._restore_spool()
        metadata = _metadata()
        if experiment:
            metadata["experiment"] = experiment
        self._emit("run.init", {"run_id": self.run_id, "project": project, "name": name,
                                 "config": config or {}, "metadata": metadata, "note": note})
        self._start_workers()
        atexit.register(self._atexit)
        return self

    def log(self, metrics: dict[str, float], step: int | None = None):
        if not self.run_id:
            raise RuntimeError("Call run.init() before run.log()")
        with self._lock:
            if step is None:
                step = self._last_step + 1
            self._last_step = max(self._last_step, step)
        values = {str(k): float(v) for k, v in metrics.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
        self._emit("run.metrics", {"run_id": self.run_id, "step": step, "metrics": values})

    def finish(self, state: str = "finished", timeout: float = 5):
        if not self.run_id:
            return
        self._emit("run.finish", {"run_id": self.run_id, "state": state})
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        self._stop.set()
        if self._worker:
            self._worker.join(timeout=1)
        self.run_id = None

    def log_text(self, message: str, level: str = "info"):
        if not self.run_id:
            raise RuntimeError("No active run")
        self._emit("run.log", {"run_id": self.run_id, "message": message, "level": level})

    def artifact(self, path: str | Path):
        if not self.run_id:
            raise RuntimeError("No active run")
        source = Path(path)
        target = self.spool_dir / "artifacts" / self.run_id / f"{uuid.uuid4()}-{source.name}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        self._emit("run.artifact", {"run_id": self.run_id, "name": source.name, "local_path": str(target)})

    def _emit(self, event_type: str, payload: dict):
        event_id = str(uuid.uuid4())
        event = {"id": event_id, "type": event_type, "timestamp": datetime.now(timezone.utc).isoformat(), "payload": payload}
        path = self.spool_dir / f"{time.time_ns()}-{event_id}.jsonl"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(event, separators=(",", ":")) + "\n")
        os.replace(temp, path)
        self._queue.put(path)

    def _restore_spool(self):
        for path in sorted(self.spool_dir.glob("*.jsonl")):
            self._queue.put(path)

    def _start_workers(self):
        self._worker = threading.Thread(target=self._upload_loop, name="fabryka-uploader", daemon=True)
        self._worker.start()
        self._system_worker = threading.Thread(target=self._system_loop, name="fabryka-system", daemon=True)
        self._system_worker.start()

    def _upload_loop(self):
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        while not self._stop.is_set() or not self._queue.empty():
            try:
                path = self._queue.get(timeout=.25)
            except queue.Empty:
                continue
            try:
                event = json.loads(path.read_text())
                if event["type"] == "run.artifact":
                    artifact_path = Path(event["payload"]["local_path"])
                    with artifact_path.open("rb") as handle:
                        response = httpx.post(f"{self.api_url}/api/runs/{event['payload']['run_id']}/artifacts",
                            files={"file": (event["payload"]["name"], handle)}, headers=headers, timeout=30)
                else:
                    response = httpx.post(f"{self.api_url}/api/events", json={"events": [event]}, headers=headers, timeout=3)
                response.raise_for_status()
                if event["type"] == "run.artifact":
                    artifact_path.unlink(missing_ok=True)
                path.unlink(missing_ok=True)
            except Exception:
                if not self._stop.wait(1):
                    self._queue.put(path)
            finally:
                self._queue.task_done()

    def _system_loop(self):
        while not self._stop.wait(15):
            if not self.run_id:
                return
            output = _command("nvidia-smi", "--query-gpu=utilization.gpu,memory.used,power.draw", "--format=csv,noheader,nounits")
            if not output:
                continue
            rows = [[float(x.strip()) for x in row.split(",")] for row in output.splitlines()]
            self.log({"system/gpu_utilization": sum(x[0] for x in rows) / len(rows),
                      "system/vram_mb": sum(x[1] for x in rows), "system/power_w": sum(x[2] for x in rows)})

    def _atexit(self):
        if self.run_id:
            self.finish(state="failed", timeout=1)
