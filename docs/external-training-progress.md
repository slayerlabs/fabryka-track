# Live progress for an existing training process

The operator registers a run under its owner's existing Track account. A separate
CPU-only sidecar reads the trainer's `events.jsonl`, backfills history, then sends
new measurements every 15 seconds. It does not import PyTorch, allocate a GPU,
restart the trainer, or upload model weights or training documents.

## Registration and service

Create a public-safe config with `planned_training_tokens`, `token_unit`, model
parameters, tokenizer vocabulary size and architecture settings. Do not include
credentials or dataset contents. On the Track server:

```sh
PYTHONPATH=current/src current/.venv/bin/python -m fabryka_track.external_training \
  --run-id RUN_UUID --owner ACCOUNT_USERNAME --name RUN_NAME \
  --config PUBLIC_CONFIG.json --started-at ACTUAL_PROCESS_START_ISO8601 \
  --credential-file /root/TRAINING_RUN.env
```

This explicitly enables public live progress for this run. Existing public runs
remain inaccessible while running unless they separately opt in. The run-scoped
token only authorizes this run's progress endpoint; account credentials are not
rotated. Transfer the credential file to the sidecar host with mode 0600.

Install `scripts/track_training_progress.py` with a pinned release and run:

```sh
python3 track_training_progress.py --events /path/to/events.jsonl \
  --state /path/to/sync-state.json --pid TRAINING_PID --run-id RUN_UUID
```

Set `TRACK_TRAINING_TOKEN` through a protected systemd `EnvironmentFile`. Run as
an unprivileged user who can read the log, with `Restart=on-failure`, `Nice=10`,
`MemoryMax=128M`, `NoNewPrivileges=true`, and a writable directory for sync state.
The service should be enabled at boot. No GPU or training service changes are
needed. `--once` backfills and exits; the default stays running and retries
network failures. Logs contain counts and error class names, never the token.

## Source, refresh and publication

- Source: the existing English-base trainer's JSONL events, including `update`,
  `checkpoint`, `evaluation`, `end`, and `failed` records.
- Refresh: the sidecar sends at most 200 events per request, in source order.
- Storage: Track's existing metrics and ingested-events tables; commit then
  acknowledge. The local cursor advances only after acknowledgement.
- Idempotency: IDs derive from the registered run UUID and source line number.
  Retrying after a lost response or restarting the sidecar does not duplicate
  measurements. Log replacement/truncation is rejected instead of mixing runs.
- Publication: `/run/RUN_UUID`, linked from the home page's live training section.
  Run plots refresh every two seconds. The source is sampled every 15 seconds.
- Freshness: the page shows the last synchronization and reports a delayed feed
  when the sidecar or source stops updating. PID start identity detects process
  exit/reuse. Completion requires an explicit end event and the token target.

The source events have no timestamps. Historical charts therefore use optimizer
steps or recorded token counts, with elapsed-time mode disabled. Database receipt
times are not presented as training event times. Throughput is the trainer's
reported per-update rate; checkpoint and other between-update overhead are not
included. ETA is an estimate at that rate. Missing validation is shown explicitly;
no validation loss, perplexity, or benchmark result is invented. Checkpoint
counters and hashes indicate a local save, not an uploaded downloadable model.

For the 150M run on simp, the source is
`/data/rfc005/runs/fabryka-150m-fast-v1/events.jsonl`. It uses 32,768 tokenizer
symbols and a 3B-token target; these counts are not UTF-8 byte counts.
