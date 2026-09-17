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
