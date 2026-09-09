# Parallel RunPod deployment — 2026-09-09

Deployed to `/opt/fabryka-track` on `rocky`; service `fabryka-track.service`.
One Uvicorn API process coordinates independent RunPod GPU nodes.

- 50 simultaneous GPU jobs; 500 outstanding jobs; five outstanding jobs per user.
- 16 concurrent controller calls. Provisioning and pending deletion occupy slots.
- Local full suite: 60 passed. GPU suite rerun before deployment: 13 passed.
- The simulated concurrency test submits 250 jobs from 50 users, fills exactly
  50 slots, verifies overlapping creates and slot reuse after deletion.
- Public homepage and OpenAPI returned HTTP 200; homepage SHA-256 matched the
  installed asset. All three deployed backend file hashes were verified.
- Server-only descriptive-name validation and dataset metadata were preserved
  by merging the queue changes into the installed `training.py`.
- Recovery backup: `/opt/fabryka-track/backups/parallel-20260909T180507Z`.
  Contains original backend files, environment, deployment marker and a
  consistent SQLite backup. Do not restore the database over subsequent runs.
- Exact source hashes and settings are recorded on the server in
  `/opt/fabryka-track/deploy/parallel-20260909/manifest.json`.
  This is a scoped source deployment; the pre-existing commit marker was retained.

The existing completed GPU job was cleaned up after restart. A queued job was
allocated above the newly applied $0.50/hour cap and automatically terminated;
it was requeued after confirming deletion and switching GPU selection to
A5000/A4000/4000 Ada. RunPod subsequently returned HTTP 500 for allocation.
The operator was asked whether to restore the previous $1/hour cap and GPU
selection. Live 50-node capacity has not been demonstrated.

The VPS had 5.5 GB free at deployment. Training executes on RunPod, but checkpoints
and logs upload to the VPS; additional artifact storage is needed for sustained
large-model workloads. Existing artifacts were preserved.

## Fresh instance on 70.34.245.254 — supersedes the initial deployment

The owner requested a fresh instance, explicitly excluding the old database,
accounts, runs and artifacts. Current backend: `root@70.34.245.254`,
`/opt/fabryka-track`, `fabryka-track.service`, loopback port 8130; Caddy owns
public HTTPS. DNS A record 581039140 now points to 70.34.245.254 (TTL 600).
The old Caddy forwards cached-DNS traffic to the new HTTPS endpoint.

- New database started empty, with the three default example datasets only.
- A disposable registration/login/API test account was removed afterwards.
- Public authenticated dataset listing measured 47.7–58.8 ms, 707-byte responses.
- Public HTTPS returned 200 in 0.29 seconds using normal DNS to 70.34.245.254.
- The server has approximately 7.4 GB RAM and 216 GB free disk after installation.
- Metadata-only dataset listing and UTF-8 size backfill passed the local 62-test suite.
- The HF login/register screen includes account creation, SlayerLab Follow,
  organization membership instructions and links, in Polish.
- Operator approved cancelling old training during retirement. Old backend service
  was disabled; original data remains on the old server for recovery.
- GPU concurrency remains 50, outstanding jobs 500, per-user limit five,
  price cap $0.50 per pod-hour. Live 50-pod availability remains unverified.

The new frontend was based on installed production source, preserving unrelated
live edits. No Git push was performed. Browser visual QA was unavailable;
JavaScript syntax, public HTML hash and actual HTTP API responses were checked.

## HF-only login, restored public corpus and training guide

Password registration, login and password-setting API routes were removed.
The login/account UI only offers Hugging Face; SDK key generation requires a
recent HF session. Public checks confirmed the removed POST routes return 405
and the HF PKCE authorization start works. The backend suite passed 62 tests.

Restored the ten verified public corpus samples from the prepared corpus pack,
not old accounts, runs or checkpoint artifacts: 655,351,158 UTF-8 bytes total.
All file SHA-256 hashes were verified during import, database/catalog identities
were checked, and the frontend catalog now points to the larger samples.
The three tiny technical examples remain stored but are hidden from the studio
when the curated catalog is available. Existing run recipes are preserved.

The public `/#guide` contains six explicitly illustrative training-curve examples:
healthy learning, overfitting, underfitting, instability, noise, and suspiciously
good validation. Metric explorer and main navigation link to the guide.
Navigation now cancels obsolete GET requests, ignores stale leaderboard responses,
and handles same-page/path links through a delegated handler. Mutations are not
aborted by navigation. Six Node regression tests passed for the published HTML:
`node --test tests/navigation.test.cjs`.

Final public HTML SHA-256:
`f48b37aff4bf279f55b751f75dd704b28a1d2267ec22c513a97c146c1b62fcab`.
Normal DNS HTTPS reached 70.34.245.254 with HTTP 200 in 0.30 seconds.
The restored 13-row dataset metadata listing measured 177.72 ms in-process.
The new-instance runs a89d8132-9a53-4092-ac39-2545c472b014 and
7eeca4cf-3d18-466b-9a96-9f3228f32de0 finished with metrics through step 525,
on A4000 and RTX 4000 Ada respectively, with cleanup confirmed. Their initial
allocation error cleared through the existing reconciliation/retry path.

## Allocation incident and document navigation, 2026-09-09

Three runs exhausted the old three-attempt allocation policy with HTTP 500 and no matching provider pod: `fc7b40de-9415-44dd-9b0f-f8c5bd77fd47`, `8f4c4d0f-b159-4db4-b632-749bfc7496aa`, and `7caf2e37-e453-4e31-8a5d-2e4425f606d2`. Run logs did not retain provider response bodies, so the underlying vendor cause is unconfirmed. Two other runs had live pods and continued reporting progress.

The controller now uses a persisted one-hour allocation window (`FABRYKA_RUNPOD_ALLOCATION_WAIT_SECONDS`), exponential cooldown capped at five minutes plus jitter, and two absent-pod confirmations before another create. The three failed allocations were requeued after verifying their deterministic pod names were absent. This does not guarantee GPU availability. Existing training runtime and hourly price limits remain in force.

Navigation now uses full document loads for studio, runs, run detail, comparisons, benchmarks, leaderboard, guide and account pages. The server validates page paths and supplies page titles; unknown paths return 404. Old hash bookmarks receive one canonical redirect. Shared JavaScript still renders interactive data and charts within each document, but clicks do not use SPA routing or hashchange handlers.

Validation: 65 existing Python tests, one new page-route test, seven JavaScript navigation/guide tests, live page title and JavaScript syntax checks. Interactive browser verification was unavailable in this session.

## Per-run cost reporting

The owner's GPU run dashboard shows a USD estimate, allocated duration and hourly rate, plus the amount and billed duration returned by RunPod when available. Estimate uses the final allocation attempt's start (derived from its persisted runtime deadline) through cleanup, excluding earlier queue attempts. It includes container startup and artifact transfer; it is not an invoice or a pure training-kernel cost.

A background refresh every five minutes reads `/billing/pods` grouped by pod ID, summing daily billing buckets only for known run pods. Snapshots replace previous totals instead of accumulating on every refresh. Missing records remain pending, and displayed provider totals are explicitly billed-so-far because reporting can lag. No provider billing request is made by a page load. Separate evaluation workers, VPS, and external storage are excluded. Existing deleted pods can be matched through retained GPUJob pod IDs.

Provider contract: https://docs.runpod.io/api-reference/billing/GET/billing/pods
Validation: 16 GPU controller tests, two cost calculation/aggregation tests, eight JavaScript tests against published HTML, and published script syntax check. At deployment, the provider had not yet reported billing rows for the new server's pods; estimates were available for prior completed runs.
