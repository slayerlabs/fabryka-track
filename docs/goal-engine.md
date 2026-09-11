# Goal engine: Track control plane and remote runtime

`/goal` accepts one active goal per signed-in account. `/status` shows the durable
status timeline, engine heartbeat, blocker/resume controls and links to private
Track runs. Goals are not public leaderboard entries. API processes never execute
goal text. The runtime runs on a separate operator-controlled machine.

## Runtime-neutral protocol

Create a goal-engine credential under **Connect an engine** on `/goal`. It is
shown once, stored hashed on the server and scoped to goal claim/progress only.
It cannot use the general account or training APIs. Use a separate existing Track
account API key if your runtime needs to launch training or upload artifacts;
keep that credential in the runtime's secret store, not goal text or status.
Creating a replacement engine credential invalidates the previous credential;
replacement is disallowed while a goal is running or stopping.

All worker calls use `Authorization: Bearer <engine credential>`:

1. `POST /api/goal-engine/claim` with `{"runtime":"your-runtime-name"}` every five
   seconds while idle. Response: `{"goal":null}` or a goal containing its ID,
   objective, tracking run ID, recent status/user context and a secret lease.
2. `POST /api/goal-engine/{id}/progress` at least every ten seconds:

   ```json
   {
     "lease": "secret-from-claim",
     "event_id": "unique-id-reused-for-retries",
     "state": "running",
     "kind": "status",
     "message": "Validated the dataset manifest. Next: inspect the training recipe.",
     "run_ids": []
   }
   ```

3. Respect `stop: true`: terminate the managed agent work, then acknowledge with
   state `cancelled`. End states are `completed`, `blocked`, `failed`, `cancelled`.
   Every ending/blocker includes a substantive message. Claim and progress replies
   do not constitute model-quality validation: completion is the runtime's reported
   result, with its evidence in the timeline and linked Track runs.
4. Reuse an event ID when retrying. Duplicate status events do not duplicate
   timeline or run-log entries. Terminal acknowledgements are replayable while the
   credential/lease identity remains unchanged. Empty heartbeat messages do not
   create timeline entries.

Leases last 90 seconds and are renewed on progress. A worker must stop its local
execution if it cannot acknowledge a heartbeat for 30 seconds, before expiry. A
lost/expired assignment returns 409. Expired work becomes **blocked**, never
silently reassigned: inspect external jobs and workspace effects before Resume.
Stop retains the active slot until acknowledgement or lease expiry. Blocking also
retains the slot. Completed, failed and cancelled goals release it. These rules
are enforced by database constraints and conditional writes, not browser state.

The protocol guarantees single active assignment and fenced status writes, not
exactly-once external side effects. A remote scheduler/training job has its own
lifecycle. The agent should record IDs and stop instructions; Stop on Track does
not imply that a separately provisioned GPU job was terminated.

## Optional remote supervisor

Install this repository on the remote machine. The supplied supervisor manages a
runtime adapter subprocess, leases, heartbeats, retries, timeout, process-group
stop and structured results. It does not select or bundle Codex or another model.

Store the engine credential in a mode-0600 file outside the agent workspace. Set
`TRACK_ENGINE_TOKEN_FILE` to that file. Then run, substituting your actual adapter:

```bash
export TRACK_URL=https://track.fabryka.ai
export TRACK_ENGINE_TOKEN_FILE=/srv/track-engine/credential
fabryka-goal-engine \
  --workspace /srv/agent-workspace \
  --state-dir /srv/track-engine/state \
  --runtime my-agent \
  --command-json '["/srv/agent/.venv/bin/python", "/srv/agent/adapter.py"]'
```

The operator chooses executable arguments locally; the website never accepts a
shell command. Keep state/credential files outside the runtime workspace. The
supervisor removes its engine credential environment variables before launching
the child. Runtime credentials and sandbox/resource boundaries remain the
operator's configuration. Default per-goal execution budgets are 20 turns and one
hour; exhaustion blocks the goal for review. `--max-turns` and `--max-seconds`
change those limits. `--once` processes at most one claimed goal for verification.

The adapter reads **one JSON object from stdin**:

```json
{
  "protocol": "track-goal-v1",
  "goal_id": "uuid",
  "objective": "User's goal and completion criteria",
  "tracking_run_id": "uuid",
  "context": ["Recent status and user responses"],
  "linked_runs": []
}
```

It writes newline-delimited JSON to stdout, flushing live status promptly:

```json
{"type":"status","message":"Inspecting the current configuration."}
{"type":"result","state":"continue","summary":"Verified the input revision.","next_step":"Run the bounded validation.","run_ids":[]}
```

Exactly one final `result` is required, followed by exit code zero. Result states
are `continue`, `completed`, `blocked`. A successful process exit without a valid
result is **failed**, never inferred completion. `continue` runs another bounded
turn with updated context. Adapter stderr is retained locally, not uploaded as
status; stdout is forwarded only through the explicit status/result contract.
Emit user-facing progress and evidence, never secrets or internal reasoning.
Only link existing Track runs owned by this account. Credentials are never given
to the adapter via its input object. Do not detach untracked local processes.

`deploy/fabryka-goal-engine.service` is an example remote-machine service. Adjust
paths, runtime name and command for that machine. Installing it is separate from
deploying the Track website; no local Codex process is started by API deployment.

## API/UI and verification

Browser APIs: authenticated `GET/POST /api/goals`, `GET /api/goals/{id}?after=N`
and `POST /api/goals/{id}/control` with `stop` or `resume` and optional blocker
response. Status is polled every three seconds; event cursors support reconnect
without duplicate display. Owner history is capped at the newest 50 goals; the
detail API retains and pages the full event history. Goals and worker tables are
additive migrations, so older Track releases can be restored without data loss.

Tests cover account isolation, credential scope, competing claims/creation,
stop/completion races, expired leases, resume fencing, replayed events, private
Track integration, invalid adapter results, bounded continuation and process stop:

```bash
python -m pytest tests/test_goals.py tests/test_goal_engine.py
```

A runtime is connected only when `/status` reports a recent heartbeat. Serving the
pages or passing an API smoke test does not prove that a production agent is
executing goals. Provision and verify the selected remote adapter separately.
