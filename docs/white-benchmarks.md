# Automatic benchmarks on White

Track's optional dispatcher uses the private Tiny-ML-Leaderboard at `http://white:8765`. Set `FABRYKA_WHITE_BENCHMARK_URL` to its Tailscale URL on the Track server. Every minute Track discovers completed public HF exports, checks compatibility, and submits at most one new evaluation. It polls queued jobs and stores their scores locally for the run's Automatic benchmarks panel. Evaluations use exact 40-character HF revisions, never a moving branch. White deduplicates the same model/revision/config; Track persists job IDs across restarts and does not automatically retry completed or failed evaluations.

Only explicitly declared trained outputs and completed public HF publications are submitted. A base-model name in training config is not evidence of trained weights and is never used as a substitute. A new publication revision triggers a new evaluation after the previous job is terminal. Private HF publications are not automatically exported or submitted.

For an SDK run with an already published, public Transformers model and tokenizer, its owner can register the output using their normal Track API bearer credential:

```
PUT /api/runs/{run_id}/white-benchmark/source
{"repo_id":"organization/trained-model","revision":"<40-character commit SHA>"}
```

`GET /api/runs/{run_id}/white-benchmark` returns status and results under the run's existing read permissions. Source registration remains owner-only. Results retain their evaluation scope; imported or White protocol scores must not be presented as Track's separate native byte-model leaderboard protocol.

White requires the companion `POST /api/models/compatibility` endpoint in `GlintBenchLiq/src/glintbenchliq/api.py`. Its CPU-only check loads configuration and tokenizer with remote code disabled, without loading weights or starting GPU work. Public repo metadata and native causal-LM support are required. It uses the existing evaluation queue and GPU worker.

## Current checkpoint limitation

Run metrics do not upload model weights. SDK users must separately publish a compatible output bundle or implement artifact upload. Track's native `model.pt` checkpoints and custom GoLLeM loaders are not Transformers bundles; they need an explicit adapter before this service can evaluate them. The panel reports `waiting_for_weights` or `unsupported_checkpoint` rather than evaluating a different model. The linked GoLLeM run had no artifacts or checkpoint records when inspected on 2026-09-24; locating its trainer was deferred by the user.

White's existing worker manages its own GPU queue and temporarily stops/restores its Qwen container during evaluations. Track does not rent GPUs, bypass that queue, or send account credentials to White.

## Existing reference models

`scripts/import_white_references.py --url http://white:8765` previews importing completed full White leaderboard entries; add `--apply` to create explicitly named `Reference: organization/model` runs. IDs are deterministic per model revision, repeated imports are idempotent, and the importer only performs GET requests to White. It retains the original job and scores without queueing any GPU work or attributing a reference model to somebody else's training run.
