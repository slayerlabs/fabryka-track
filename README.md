# Fabryka Track

A deliberately small experiment tracker for training runs: projects, runs, metrics,
system metrics, logs, artifacts, and notes. It provides exactly three views: runs,
one run, and comparison.

## Start locally

```bash
uv sync --extra test
uv run fabryka-track
```

Open <http://localhost:8000>. Local development uses SQLite and filesystem artifact
storage. For production, copy `.env.example`, start PostgreSQL with
`docker compose up -d`, and configure Cloudflare R2 variables if desired.

## Track a run

```python
from fabryka_track import run

run.init(
    project="qwen-27b",
    name="cpt-replay-20",
    experiment="qwen-cpt-replay-ablation",
    config={"lr": 3e-5, "batch_size": 128, "replay_en": 0.20},
)

for step in range(100):
    # Training is never coupled to tracker availability. Every event is first
    # persisted under ~/.fabryka-track/spool and uploaded in the background.
    run.log({"train/loss": 2.0 - step / 100, "throughput/tokens_sec": 478}, step=step)

run.log_text("checkpoint saved")
run.artifact("checkpoint/config.json")
run.finish()
```

Git state, host, GPU model/count, CUDA, PyTorch, Python, command, and timestamps are
captured automatically. GPU utilization, VRAM, and power are sampled every 15 seconds
when `nvidia-smi` is available. Pending metric events survive process and network
failure and are retried on the next run.

## API

Interactive documentation is at `/docs`. Useful endpoints include:

- `POST /api/events` — idempotent batched event ingestion
- `GET /api/projects/{name}/runs` — sortable/filterable run list
- `GET /api/runs/{id}` — config, metric series, logs, artifacts, and notes
- `GET /api/compare?ids=...&ids=...` — comparison data
- `PATCH /api/runs/{id}/notes` — update the run purpose and conclusion
- `POST /api/runs/{id}/artifacts` — store locally or in R2

