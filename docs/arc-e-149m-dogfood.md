# ARC-E 149M Track dogfood run

This is a **Track-owned pilot**, not a manually operated RunPod experiment.
Track is the system of record for the run configuration, scoped worker
credential, progress, checkpoints, owner stop request, and evaluation evidence.
RunPod is only the GPU worker.

The first registered run is the 1B-token `r0a` FineWeb-Edu control in
[`../configs/arc-e-149m-r0a-pilot.json`](../configs/arc-e-149m-r0a-pilot.json).
It is deliberately not the 100B run. The 100B run is blocked until the pilot
records real throughput, memory, loss, validation BPB, checkpoint recovery, and
cost on the exact 5090 image.

## Preflight gate

Before registering the run, attach the following to the immutable config or
the Track note: the resolved dataset revision, 32K tokenizer artifact SHA-256,
deduplication/ARC-exclusion report, exact state-dict parameter count, container
image digest, and the evaluator revision. Do not replace these with a model-card
claim or a planned value.

The 149,863,232 target must be counted from the instantiated model's unique
trainable state-dict elements. A mismatch with the manifest rejects the pilot.

## Register and execute through Track

On the Track server, after all preflight values are fixed, register a private
run before starting the worker:

```sh
run_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
PYTHONPATH=current/src current/.venv/bin/python -m fabryka_track.external_training \
  --run-id "$run_id" --owner TRACK_ACCOUNT_USERNAME \
  --name 'ARC-E 149M · R0a FineWeb-Edu · 1B pilot' \
  --config current/configs/arc-e-149m-r0a-pilot.json \
  --started-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --credential-file /root/arc-e-149m-r0a-track.env --private
```

Copy only that run-scoped credential to the worker in a mode-0600 environment
file. The trainer writes its JSONL event stream, while the CPU-only sidecar is
started alongside it:

```sh
TRACK_TRAINING_TOKEN=... python3 track_training_progress.py \
  --events /workspace/run/events.jsonl --state /workspace/run/track-sync.json \
  --pid TRAINER_PID --run-id "$run_id" \
  --stop-file /workspace/run/TRACK_STOP
```

The trainer must check `TRACK_STOP` between optimizer updates. On a stop request
it saves a verified checkpoint, writes an `end` event with `status: "paused"`,
and exits. Track therefore controls safe stop intent; the trainer owns safe
checkpointing and process exit. A stale/no-longer-running feed is visibly marked
and never mistaken for completion.

## Do not launch yet

The current production Track RunPod template is the small byte-level training
worker, not this Qwen-style BPE model. It must not be selected for this run.
This dogfood contract prepares the managed pilot and prevents a false launch;
the dedicated 149M worker image plus its provenance preflight are still needed
before the run is registered or a paid pod is created.
