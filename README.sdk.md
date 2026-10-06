# Fabryka SDK

The official Python client for the hosted Fabryka tracking API.

```bash
pip install fabryka
```

The SDK sends runs, metrics, logs and artifacts to your configured Fabryka API.
It does **not** start a dashboard, run a server, create a local database, or
provision GPUs.

## Configure

Create an API key in your Fabryka account and set:

```bash
export FABRYKA_API_URL=https://track.fabryka.ai
export FABRYKA_API_KEY=your_api_key
```

## Track a run

```python
from fabryka import run

run.init(
    project="sub150run",
    name="lfm-32m",
    experiment="architecture-ablation",
    config={"parameters": 32_793_472, "tokens": 1_000_000_000},
)

for step in range(1000):
    run.log({"train/loss": loss, "throughput/tokens_sec": tokens_per_second}, step=step)

run.log_text("checkpoint saved")
run.artifact("runs/checkpoint-step-001000.pt")
run.finish()
```

Events are persisted in a local spool before upload. Temporary network
failures therefore do not lose metrics; pending events are retried by the
client. Set `FABRYKA_SPOOL_DIR` to choose a different spool location.

The package exposes `RunClient` for multiple API clients or dependency
injection:

```python
from fabryka import RunClient

client = RunClient(api_url="https://track.fabryka.ai", api_key="...")
client.init(project="demo", name="run-1")
client.log({"loss": 1.2}, step=0)
client.finish()
```

The self-hosted API and dashboard live in the source repository, but are not
included in this client distribution.

## Resume delivery and observe an existing training job

Use a stable run ID and the same spool directory after a process restart.
`init()` automatically recovers pending events belonging to that run. It leaves
other runs' pending events alone. Recovery retries delivery; it does not restore
model weights, optimizer state, or training progress.

```python
client = RunClient(spool_dir="runs/experiment/track-spool")
client.init(project="Slayer149", name="White continuation", run_id=saved_run_id)
client.log({"train/loss": 2.7}, step=28540,
           event_id=source_event_uuid,
           timestamp="2026-10-06T23:34:14.469571+00:00")
delivered = client.flush(timeout=10)
client.close(timeout=10)  # Stop an observer without finishing the training run.
```

Persist the run ID before emitting training events. Event IDs for metric and log
backfills must be stable UUIDs from the source record, so retries do not duplicate
records. Timestamps must be ISO 8601 source times. `flush()` includes requests
already in flight and returns `False` on timeout. `close()` preserves undelivered
spool files without publishing a terminal run state; `finish()` publishes the
terminal state and also returns whether delivery drained within its timeout.
Only one client process should own a run's spool directory at a time.

Artifacts are copied into the spool and retained until the API accepts the upload.
The hosted API currently limits each artifact to 20 MB. Keep larger optimizer
checkpoints in durable external storage and upload a small receipt containing
their location, size and SHA-256. A receipt does not upload or back up the weights.
Artifact uploads do not yet have the event-ID deduplication used by metrics/logs;
an ambiguous HTTP response can produce a duplicate artifact.

## Share selected metric series

Core loss, progress, throughput and gradient series are already visible on public
run links. Owners can explicitly publish additional exact metric paths:

```python
client["visibility/public_metrics"] = [
    "optimizer/learning_rate", "system/gpu0/utilization", "val/fineweb_edu/loss",
]
```

The list permits at most 100 exact paths and no wildcards. Assign `[]` to revoke
this additional sharing. It does not expose logs, artifacts, attributes, or
private configuration, and it does not make a private run public.

## Neptune-style compatibility

Common Neptune calls can use the Fabryka adapter:

```python
from fabryka.neptune import init_run

run = init_run(project="sub150run", api_token="...", name="baseline")
run["train/loss"].append(2.1, step=0)
run["model/parameters"] = 32_793_472
run["checkpoints/latest"].upload("runs/latest.pt")
run.stop()
```

The adapter sends data to Fabryka and does not install or contact Neptune.
