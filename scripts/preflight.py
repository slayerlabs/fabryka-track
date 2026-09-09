"""RunPod preflight for a fabryka-track workshop.

Checks the three hard run-blockers before students launch GPU runs:
  1. RunPod API key present  -- else allowed() is False => HTTP 403 for everyone.
  2. Access / allow-list      -- empty list => only Hugging-Face-connected users.
  3. public_url reachability   -- else the in-pod runner raises 'Callback unavailable'.

Run:  uv run python scripts/preflight.py
Exit: 0 when no FAIL, 1 when any FAIL. Uses only the standard library + settings.
"""
from __future__ import annotations

import socket
import sys
import urllib.error
import urllib.request

from fabryka_track.settings import settings

OK, WARN, FAIL = "OK", "WARN", "FAIL"


def check_api_key():
    if settings.runpod_api_key:
        return OK, "RunPod API key is set."
    return FAIL, ("runpod_api_key is empty => allowed() returns False for everyone "
                  "(HTTP 403 on POST /training compute=runpod). Set FABRYKA_RUNPOD_API_KEY.")


def check_allowlist():
    users = [u.strip() for u in settings.runpod_allowed_users.split(",") if u.strip()]
    if "*" in users:
        return OK, "Allow-list = '*' (every signed-in user may use GPU)."
    if users:
        return OK, f"Allow-list has {len(users)} explicit user(s): {users}."
    return WARN, ("Allow-list is empty: only Hugging-Face-connected accounts may use GPU; "
                  "password-only / service users get 403. For a workshop set "
                  "FABRYKA_RUNPOD_ALLOWED_USERS='*' or list the participants.")


def check_public_url(timeout: float = 5.0):
    base = settings.public_url.rstrip("/")
    url = base + "/api/runner/__preflight__"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as resp:
            code = resp.status
    except urllib.error.HTTPError as exc:
        code = exc.code  # any HTTP status means the server is visible from here
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        return FAIL, (f"Control-plane UNREACHABLE from here ({exc}). RunPod pods call back to "
                      f"{base}/api/runner/<run>; unreachable => runner raises 'Callback unavailable' "
                      "and the run fails hard. NOTE: this probe is host->public_url; the real binding "
                      "requirement is RunPod-cloud->public_url, so a publicly reachable / tunnelled URL is needed.")
    return OK, (f"Control-plane reachable from here (HTTP {code}) at {base}. "
                "Caveat: verifies host->URL, not RunPod-cloud->URL (that still needs a public URL).")


def main() -> int:
    print(f"fabryka-track RunPod preflight -- image={settings.runner_image}, gpu={settings.runpod_gpu_type}, "
          f"max_concurrent={settings.runpod_max_concurrent}, public_url={settings.public_url}")
    checks = [
        ("API key", *check_api_key()),
        ("Access", *check_allowlist()),
        ("public_url", *check_public_url()),
    ]
    worst = OK
    for name, status, msg in checks:
        print(f"[{status:>4}] {name}: {msg}")
        if status == FAIL:
            worst = FAIL
        elif status == WARN and worst != FAIL:
            worst = WARN
    print(f"\nRESULT: {worst}")
    return 1 if worst == FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
