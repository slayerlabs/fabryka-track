# Slayer149 SDK dogfooding

Live experiment: [Slayer149 balanced continuation on White](https://track.fabryka.ai/run/929d5302-e89a-4a92-a083-0b34e15661c2).

The external trainer resumes the original 149M checkpoint and optimizer state on
two RTX 3090 GPUs. A separate systemd observer uses the published SDK package's
`RunClient`; it reads real journal records and GPU telemetry without restarting
or importing the trainer. The patched development SDK is installed on White;
this is not a claim that these fixes have already been released on PyPI.

## Source and deployment

- Canonical local checkout: `/Users/kacper/Local/Ventures/fabryka-track`.
- Repository: `https://github.com/slayerlabs/fabryka-track` (`kwikiel` redirects).
- SDK: `src/fabryka/client.py`; its distribution includes only `src/fabryka`.
- API and public run visibility: `src/fabryka_track/api.py`.
- Namespace attributes and series: `src/fabryka_track/namespaces.py`.
- Website: `frontend/src/`, with routing in `App.tsx` and run views in the page components.
- White integration: `/root/slayer149-balanced/scripts/track_white.py` and
  `slayer149-track.service`; trainer service: `slayer149-balanced.service`.

Current production is `root@70.34.245.254`, Ubuntu, Caddy, systemd and SQLite.
Do not infer production from the `rocky` SSH alias: it now resolves to another
machine with an older inactive Track installation. Read
[production deployment](github-deployment.md) before changing releases. Tested
pushes to `main` deploy through GitHub Actions, with a database backup, immutable
release directory, atomic switch, health checks and rollback. The live commit is
reported by `/health` and `/opt/fabryka-track/current` on the production host.

## What this experiment measures

Training loss, learning rate, throughput, tokens, progress, measured pre-clipping
gradient norm and clipping threshold come from trainer logs. The clipping flag
is derived by comparing that norm with the configured threshold; a post-clipping
norm is not measured by the current trainer. Source journal timestamps are kept;
historical metrics do not inherit the import time. Stable event UUIDs make metric
and log replay idempotent. The cursor advances after the SDK has durably spooled
the corresponding event. Journal vacuum recovery uses overlapping source times.

Validation includes each corpus source. The displayed aggregate is an unweighted
mean of the four source losses, and perplexity is its exponential. These are
validation metrics, not a leaderboard result. Telemetry samples both GPUs every
30 seconds. Configuration, corpus hash gates, smoke verification, evaluation
JSON and checkpoint receipts are small uploaded artifacts.

Optimizer checkpoint weights are approximately 1.25 GB and remain on White.
The hosted upload limit is 20 MB, so receipts contain SHA-256, byte count and
location instead. A receipt does not mean weights were uploaded or remotely
backed up. The observer closes independently of the experiment; completion
requires a complete final checkpoint and all three final evaluation files.

## Gaps exposed by this run

Fixed in this change: startup spool recovery for a stable run ID, waiting for
in-flight requests, retaining failed artifact uploads, artifact namespace
forwarding, explicit observer close, source-time/idempotent metric backfills,
owner-selected public metric paths, and removing byte-token/next-byte claims
from generic SDK runs while displaying their declared model and compute.

Remaining product work, based on this experiment:

1. Large artifact streaming or external object references, with hash verification
   and resumable multipart uploads; do not buffer gigabyte checkpoints in API RAM.
2. Artifact upload idempotency, including an accepted upload followed by a lost
   response. Metric/log event deduplication already covers their replay.
3. Show delivery backlog and last successful upload in the SDK and run UI so
   network failure is visible rather than silently retried.
4. Share a run with a human collaborator without making all configuration,
   notes, logs or artifacts public. This run belongs to an independent machine
   account; its public URL provides selected metric visibility only.
5. A first-class resume segment and checkpoint lineage for external trainers,
   distinguishing full optimizer-state continuation from a weights-only fork.

These are concrete dogfooding gaps, not a claim of feature parity with W&B or Neptune.
