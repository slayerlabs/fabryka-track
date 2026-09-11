"""Runtime-neutral remote goal supervisor; Track is the durable control plane."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time
from uuid import uuid4

import httpx



class LeaseLost(Exception):
    pass


class Remote:
    def __init__(self, url, token, state_dir, runtime="external"):
        self.runtime = runtime
        self.base = url.rstrip("/") + "/api/goal-engine"
        self.client = httpx.Client(headers={"Authorization": "Bearer " + token}, timeout=10)
        self.state_dir = state_dir

    def claim(self):
        response = self.client.post(self.base + "/claim", json={"runtime": self.runtime})
        response.raise_for_status()
        return response.json()["goal"]

    def post(self, goal, payload):
        path = self.state_dir / "pending.json"
        write_json(path, {"goal_id": goal["id"], "payload": payload})
        deadline = time.monotonic() + 25
        while True:
            try:
                response = self.client.post(self.base + "/" + goal["id"] + "/progress", json=payload)
                if response.status_code in (401, 409):
                    raise LeaseLost("Engine credential or assignment is no longer valid")
                response.raise_for_status()
                path.unlink(missing_ok=True)
                return response.json()
            except httpx.HTTPError:
                if time.monotonic() >= deadline:
                    raise LeaseLost("Track is unreachable; stopping the child before its lease expires")
                time.sleep(2)

    def report(self, goal, message="", state="running", kind="status", run_ids=None):
        return self.post(goal, {"lease": goal["lease"], "event_id": str(uuid4()), "message": message[:8000],
            "state": state, "kind": kind, "run_ids": run_ids or []})

    def replay(self):
        path = self.state_dir / "pending.json"
        if path.exists():
            item = json.loads(path.read_text())
            try:
                self.post({"id": item["goal_id"]}, item["payload"])
            except LeaseLost:
                path.rename(self.state_dir / ("unacknowledged-" + str(uuid4()) + ".json"))


def write_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2))
    tmp.chmod(0o600)
    tmp.replace(path)


def terminate(proc):
    """Only terminate this worker's child process group, never unrelated jobs."""
    if proc is None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def assignment(goal, context):
    """Versioned JSON stdin contract; never interpolate a goal into a command."""
    return {"protocol": "track-goal-v1", "goal_id": goal["id"],
            "objective": goal["objective"], "tracking_run_id": goal["run_id"],
            "context": context, "linked_runs": goal.get("linked_runs", [])}



def execute(remote, goal, args):
    folder = args.state_dir / goal["id"]
    folder.mkdir(mode=0o700, exist_ok=True)
    context = list(goal.get("context", []))
    started = time.monotonic()
    proc = None
    try:
        for turn in range(1, args.max_turns + 1):
            ack = remote.report(goal, f"Starting work turn {turn}. Workspace: {args.workspace.name}.")
            if ack["stop"]:
                remote.report(goal, "Stopped before starting the next turn.", "cancelled")
                return
            final_results = []
            # Transport credentials stay with this supervisor, never in the agent environment.
            env = {k: v for k, v in os.environ.items() if k not in {"TRACK_ENGINE_TOKEN", "TRACK_ENGINE_TOKEN_FILE"}}
            events = queue.Queue(maxsize=1000)
            with (folder / f"turn-{turn}.stderr").open("w") as errors:
                proc = subprocess.Popen(args.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=errors, text=True, env=env, cwd=args.workspace, start_new_session=True)
                proc.stdin.write(json.dumps(assignment(goal, context)) + "\n")
                proc.stdin.close()

                def consume(stream):
                    for line in stream:
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        # Only the explicit public status protocol is forwarded.
                        # Raw logs/tool output/reasoning are not a status feed.
                        if not isinstance(obj, dict):
                            continue
                        if obj.get("type") == "result":
                            if len(final_results) < 2:
                                final_results.append(obj)
                        elif obj.get("type") == "status" and isinstance(obj.get("message"), str):
                            try:
                                events.put_nowait(obj["message"][:8000])
                            except queue.Full:
                                pass
                    stream.close()

                reader = threading.Thread(target=consume, args=(proc.stdout,), daemon=True)
                reader.start()
                last_ping = 0
                activity = ""
                while proc.poll() is None:
                    try:
                        activity = events.get(timeout=0.2)
                    except queue.Empty:
                        pass
                    if time.monotonic() - started > args.max_seconds:
                        terminate(proc)
                        remote.report(goal, "Engine work budget reached. Review progress and resume to continue.", "blocked")
                        return
                    if time.monotonic() - last_ping >= 10:
                        ack = remote.report(goal, activity, kind="activity")
                        activity = ""
                        last_ping = time.monotonic()
                        if ack["stop"]:
                            terminate(proc)
                            remote.report(goal, "Local agent process stopped. External jobs, if any, need their own stop controls.", "cancelled")
                            return
                reader.join(timeout=2)
                exit_code = proc.returncode
                terminate(proc)  # Reap any child processes left in the process group.
                proc = None
            if exit_code != 0 or len(final_results) != 1:
                remote.report(goal, "Agent execution failed. Inspect the local engine log, then create a new goal after fixing it.", "failed")
                return
            try:
                data = final_results[0]
                if data["state"] not in {"continue", "completed", "blocked"} or not isinstance(data["summary"], str) or not data["summary"].strip():
                    raise ValueError("Invalid result")
                if not isinstance(data["next_step"], str) or not isinstance(data["run_ids"], list) or len(data["run_ids"]) > 30 or not all(isinstance(v, str) for v in data["run_ids"]):
                    raise ValueError("Invalid result")
            except (KeyError, ValueError, TypeError):
                remote.report(goal, "Agent returned an invalid result. Completion was not accepted.", "failed")
                return
            message = data["summary"] + ("\nNext: " + data["next_step"] if data["next_step"] else "")
            context.append(message)
            state = "running" if data["state"] == "continue" else data["state"]
            ack = remote.report(goal, message, state, "result", data["run_ids"])
            if ack["stop"]:
                remote.report(goal, "Agent stopped between turns.", "cancelled")
                return
            if state != "running" or ack["state"] == "cancelled":
                return
        remote.report(goal, "Turn budget reached. " + context[-1], "blocked")
    except OSError:
        terminate(proc)
        proc = None
        remote.report(goal, "Could not execute the runtime adapter. Check its command, workspace and local engine log.", "failed")
    except LeaseLost as exc:
        print(str(exc), flush=True)
    finally:
        terminate(proc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("TRACK_URL", "https://track.fabryka.ai"))
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, default=Path.home()/".fabryka-track"/"goal-engine")
    parser.add_argument("--command-json", required=True, help='Trusted operator command as JSON argv, e.g. ["python", "adapter.py"]')
    parser.add_argument("--runtime", default="external", help="Display name of the connected runtime")
    parser.add_argument("--max-turns", type=int, default=20)
    parser.add_argument("--max-seconds", type=int, default=3600)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    try:
        args.command = json.loads(args.command_json)
        if not isinstance(args.command, list) or not args.command or not all(isinstance(v, str) and v for v in args.command):
            raise ValueError()
    except ValueError:
        parser.error("--command-json must be a nonempty JSON array of command arguments")
    args.workspace = args.workspace.resolve(strict=True)
    args.state_dir = args.state_dir.expanduser().resolve()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.state_dir.chmod(0o700)
    if args.max_turns < 1 or args.max_seconds < 1:
        parser.error("Work budgets must be positive")
    token_file = os.environ.get("TRACK_ENGINE_TOKEN_FILE")
    token = Path(token_file).read_text().strip() if token_file else os.environ.get("TRACK_ENGINE_TOKEN", "")
    if not token.startswith("fte_"):
        parser.error("Set TRACK_ENGINE_TOKEN_FILE to the private credential file created from /goal")
    # One process per state directory, even after service restarts.
    with (args.state_dir/"engine.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("An engine is already using this state directory")
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        remote = Remote(args.url, token, args.state_dir, args.runtime)
        remote.replay()
        print("Goal engine connected to " + args.url + "; workspace " + str(args.workspace), flush=True)
        try:
            while True:
                try:
                    goal = remote.claim()
                    if goal:
                        execute(remote, goal, args)
                    if args.once:
                        return
                except httpx.HTTPError as exc:
                    print("Track connection error: " + type(exc).__name__, flush=True)
                time.sleep(5)
        except KeyboardInterrupt:
            print("Goal engine stopped. Any interrupted lease will require reconciliation.", flush=True)
        finally:
            remote.client.close()


if __name__ == "__main__":
    main()
