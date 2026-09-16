# Fabryka Track

A minimal training studio: mix text datasets with sliders, run a tiny transformer
smoke test, and watch real metrics. Includes experiment tracking, run comparison,
logs, checkpoints, and notes.

The entire website uses React 19, [Refine Core](https://refine.dev/core), and React
Router. Refine queries and mutations connect to the existing same-origin FastAPI
API; session authentication, CSRF protection, and authorization remain server-owned.

## Start locally

```bash
npm --prefix frontend ci
npm --prefix frontend run build
uv sync --extra test
uv run fabryka-track
```

Open <http://localhost:8000>. Local development uses SQLite and filesystem artifact
storage. For production, copy `.env.example`, start PostgreSQL with
`docker compose up -d`, and configure Cloudflare R2 variables if desired.

Node.js 22+ is required to build the website. Vite writes the production bundle to
`src/fabryka_track/web/`; the Python wheel includes it. Build before installing or
packaging Python. GitHub CI builds and packages the same frontend for deployment;
the release script retains the previous release and backs up SQLite before restart.

For frontend hot reload, start the API on port 8131 and Vite in a second terminal:

```bash
uv run uvicorn fabryka_track.api:app --host 127.0.0.1 --port 8131
npm --prefix frontend run dev
```

Use Vite's displayed URL; it proxies API requests to port 8131. Frontend source is
in `frontend/src/`, including React page components, scoped styles and inert
authored RFC content. `scripts/render_training_goal.py` regenerates the RFC content;
`scripts/update_corpus_catalog.py` updates the catalog imported from
`docs/corpus-samples.json`. Neither script rewrites an executable HTML application.

Frontend checks: `npm --prefix frontend run build` and
`node --experimental-strip-types --test tests/*.test.mjs`. Browser smoke checks
must cover authenticated training/run workflows as well as anonymous public pages.

### Runs dashboard — 2026-09-16

Added the white workspace dashboard with experiment-grouped run trees, status/date
filters, real validation-loss sparklines, comparison selection and an owner-only
checkpoint inventory. Fork and Retry restore the selected checkpoint's recipe in
Training studio and require an explicit launch; they never start GPU work on click.
F1 and GPU usage remain unavailable when not reported, rather than showing sample
values. The dashboard uses `GET /api/dashboard`; `/checkpoints` supports downloads
and reviewed forks. See [run workspace](docs/run-workspace.md).

Fixed Plotly trace identifiers so metric names containing slashes no longer crash
navigation away from a run or comparison chart.

### Frontend migration — 2026-09-16

Replaced the standalone HTML/JavaScript application with a full React + Refine
frontend, including public RFCs, research notes, accounts, training, run workspaces,
comparison, benchmarks and leaderboards. Existing document URLs, the `/goal`
redirect, agent-readable Markdown and API contracts are preserved.

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


## Training studio

The homepage is a three-step workflow: mix datasets with percentage sliders, set
up training, then review and start. The sliders redistribute the remaining share
so the total stays at 100%. Upload UTF-8 text files (100+ characters, up to 2 MB)
or use the three short, original example texts. Draft settings stay in your browser.

The built-in smoke-test model is a **134,912-parameter causal transformer** trained
from scratch on CPU: two layers, four heads, width 64, a 256-byte vocabulary, and
32-byte context. The default is 100 steps with eight sequences per batch. This is
a workflow smoke test, not a production-quality LLM. It needs no external model,
dataset download, API key, or GPU.

Each batch samples sources according to the chosen percentages. The last 10% of
each source is held out before sampling; short splits use shorter contexts.
Training is sampled with replacement. Validation uses a fixed seeded batch.
The UI polls real training loss, validation loss/perplexity and byte-token
throughput every two seconds. Compare quality only with matched validation data;
changing the mix also changes validation sampling.

Runs persist in the tracker database. Completed runs provide `model.pt` and
`recipe.json`, including source SHA-256 hashes and settings. Load a checkpoint:

```python
import torch
from fabryka_track.training import TinyTransformer

checkpoint = torch.load("model.pt", map_location="cpu", weights_only=True)
model = TinyTransformer()
model.load_state_dict(checkpoint["state_dict"])
model.eval()
```

Run this local MVP with **one server process / one Uvicorn worker**. It trains one
job at a time and allows up to five active or queued jobs. Stop controls cancel a
job; a server restart marks unfinished local jobs interrupted. CPU runs do not resume; optional GPU dispatch is described under RunPod training. Existing SDK tracking endpoints remain available.
The app requires an account for private workspace access. Public leaderboard scores are opt-in.

New endpoints: `GET/POST /api/datasets`, `POST /api/training`, and
`POST /api/training/{id}/stop`. Runner integration endpoints are
`GET /api/training/{id}/manifest` and `GET /api/datasets/{id}/content`. The
manifest contains immutable dataset IDs, byte counts, weights, SHA-256 hashes,
and content URLs. Dataset content responds with `ETag` and
`X-Dataset-SHA256`; a runner should verify both before materializing a mix.

RunPod runner lifecycle is terminate-after-sync: it must upload and verify
metrics, logs, manifest, and retained checkpoints before terminating the
instance. A failed run should upload diagnostics and then shut the instance down
unless an explicit keep-alive/debug mode is selected. This prevents paid
instances being left running after a job completes.

## Chinchilla budget planning

The UI defaults to a 100-step upper limit with validation-guided early stopping.
The studio defaults to a 20 training byte tokens per parameter upper limit for
the chosen Tiny or Small model. The API keeps manual steps as its backward-compatible
default; send `budget_mode: "chinchilla"` to calculate steps automatically.
The server computes `ceil(20 * parameters / (batch_size * training_context_length))`,
using the shortest selected source's training split to match actual batching.
Manual mode retains its 2,000-step limit. Automatic mode permits the calculated
longer run. Config and recipe include the planned token count and ratio;
`training/tokens_seen` records actual processed byte tokens, excluding validation.

This is an extrapolated heuristic, not a measured optimum for tiny byte models.
Repeated sampling is not fresh data. With RunPod selected, model buttons configure the actual GPU architecture. The
20x mode derives the budget from its exact parameter count; custom token budgets
are accepted in millions. In CPU mode, the separate GPU calculator remains
planning metadata and does not resize the CPU model.

## Preventing overfitting on small sources

New runs enable early stopping by default (`early_stopping: true`, `patience: 20`,
`min_delta: 0.01`). Validation uses the same seeded held-out batch throughout a
run, at initialization, every update through step 100, then every 10 updates and
at the step limit. Twenty checks without a cumulative improvement of 0.01 stop
the run. This small validation sample is a diagnostic, not a general benchmark.

`model.pt` saves the weights with the lowest measured validation loss, even when
early stopping is disabled. It includes `best_step` and `best_val_loss`. Completed
runs store `training_result` in metadata and in `recipe.json`: actual updates,
tokens processed, best score, checkpoint step, and stop reason. Early stopping
finishes successfully; progress remains the actual fraction of the requested
upper limit. Cancelled/interrupted runs retain their existing no-artifact behavior.
The leaderboard uses saved-checkpoint validation scores; curves retain all history.

The studio shows available training bytes and the largest expected per-source
reuse at the step limit, weighted by the selected mix. This is expected sampled
volume divided by source size, not a count of complete epochs or unique tokens.
A one-time draft migration changes previous drafts to a maximum of 100 manual
steps while preserving their datasets, model and other settings. Existing runs
and checkpoints are not rewritten. More varied data is still necessary before
larger models or longer budgets can produce meaningful generalization.

## User accounts

Sign in at `/#login` with Hugging Face. The first successful HF sign-in creates
an account automatically. Password login, password registration and password
changes are disabled; their API routes are not registered.
`/#account` provides sign-out and SDK API key management. Generating a key requires
a Hugging Face sign-in within the last five minutes. Session tokens live in
HttpOnly, SameSite=Lax cookies (Secure over HTTPS), expire after 14 days, and are
stored only as hashes. HF authentication attempts are rate-limited.
Browser mutations require X-Track-Request: 1 and reject foreign Origin headers.

Datasets, private run details, notes, logs, manifests and artifacts are owner-only.
Included example datasets are available to every signed-in account. Studio runs
are public by default once finished and share leaderboard data and a read-only
run detail page with metric curves and selected training settings:
username, run name, metrics, date, update count and mixture percentages. Uploaded
filenames, content, logs, notes and model downloads stay private. Unpublishing
removes the public score and prevents other accounts from generating new samples.
Signed-in users can try saved checkpoints of public finished Studio runs through
**Sample generations**, including models trained by other users. Checkpoint downloads,
notes, logs and editing remain owner-only. See [checkpoint sampling](docs/run-workspace.md)
for request limits, cached decoding and partial output behavior.
The SDK cannot overwrite studio metrics or checkpoints.

Public checkpoint evaluation tables and comparisons are available at
`/benchmark-results`, without sign-in. They update from completed evaluations of
public runs and retain exact metric names, checkpoint evidence and a separate smoke
view. See [published benchmark results](docs/published-benchmark-results.md).
For the full pinned suite and an existing-GPU batch, see the
[simp leaderboard campaign](docs/simp-leaderboard-campaign.md).

Set `FABRYKA_API_URL=https://track.fabryka.ai` and `FABRYKA_API_KEY` in the SDK
process environment. HTTP API clients send `Authorization: Bearer <key>`.
API keys can be rotated or revoked in Account, and are shown only when generated.
The server does not need a global API key. Existing SDK processes must configure
their owner's new credential; anonymous event ingestion is no longer permitted.

Startup applies an idempotent additive migration. Existing runs and uploaded
sources keep null ownership; old scores remain public as Legacy. No registrant
is automatically granted access to those private artifacts or sources. After
the workspace owner registers and identifies their username, a server operator
can assign the old workspace:

```bash
python -m fabryka_track.account_admin claim-legacy USERNAME
```

Before upgrading, back up the database with its native consistent-backup tool
and preserve the installed source. Do not restart while training runs are active.

## Hugging Face sign-in

Hugging Face is the only login and registration method. Existing Track users
can connect an HF identity from Account; new HF sign-ins receive a separate
`hf_` username. Identity is keyed by the provider's stable `sub`, never inferred
from matching usernames or email addresses. No existing workspace is claimed
automatically. Accounts can generate an API key within five minutes of signing
in; older sessions must sign in with HF again.

This uses the Hugging Face documented Client ID Metadata Document flow with
PKCE S256. `/.well-known/oauth-cimd` publishes the client metadata. Configure
`FABRYKA_PUBLIC_URL` to the public HTTPS origin (default `https://track.fabryka.ai`).
The callback is `/api/auth/huggingface/callback`; the client ID is the metadata
URL. Hugging Face fetches this public document, so no client secret is required.
A local development origin must be configured separately and reachable by HF.

OAuth attempts are bound to a random HttpOnly browser cookie, expire after ten
minutes and can be consumed only once. Connecting an identity additionally
requires the same Track session at the start and callback. Only `openid profile`
scopes are requested for sign-in. The server exchanges the authorization code and fetches
userinfo over HTTPS, then discards provider tokens and issues a regular Track
session. Provider cancellation and failed verification do not change accounts.

Reference: https://huggingface.co/docs/hub/oauth

## Publish a completed model to SlayerLab

Open a finished studio run and use **Publish model to SlayerLab**. Connect your
Hugging Face account in Account first. Choose a new repository name and private
(default) or public visibility, then authorize the export with that same HF
identity. Grant access to SlayerLab; the HF account must have permission to
create models in that organization. The destination namespace is fixed. Models can only be exported under `SlayerLab/`.

To join, sign in at [SlayerLab on Hugging Face](https://huggingface.co/SlayerLab)
and click **Follow**, then **Join / Request to join**. If the join option is not
visible, ask a SlayerLab
administrator for an invitation and provide your HF username. After approval,
you need permission to create model repositories. Connect that same HF account
in Track and select SlayerLab when authorizing publication.
See [HF membership instructions](https://huggingface.co/docs/hub/organizations-managing).

Kacper Wikieł also organizes Fabryka AI in-person workshops in Warsaw, covering
training a language model from scratch and publishing it on Hugging Face.

Export authorization requests `openid profile contribute-repos read-memberships`
with the same PKCE and browser/session binding as sign-in. The upload token is
held only in the background task's memory. An interrupted upload requires fresh
authorization. Existing repositories are not adopted or overwritten; retries
can resume a repository recorded as created by this run's export.

The export contains safetensors weights, architecture and byte tokenizer config,
training metrics, a model card, standalone PyTorch generation code, requirements,
and a SHA-256 manifest. Private source text, filenames, hashes, notes and logs
are excluded. Completion is reported only after downloading every file from the
uploaded commit and verifying its hash. No license is assigned automatically.

## Working with another developer

GitHub `main` is the shared source history. Fetch before starting work, use a
feature branch for concurrent changes, and commit and push each finished change.
Before deployment, check the installed source against the previously deployed
commit; reconcile any server edits rather than overwriting them. Record the
new deployed commit in `DEPLOYED_COMMIT` on the server. Back up source and SQLite,
and deploy only when training and HF uploads are idle.

On 2026-09-08, the 17 ownerless legacy runs were removed from production after a
consistent database backup. The four owned runs were preserved. Recovery files
are under `/opt/fabryka-track/backups/remove-legacy-20260908-113443/`.

## TinyLM evaluation

In **Benchmarks**, click the **TinyScore** column header to sort all evaluation
history from highest to lowest; click again for lowest to highest. Missing scores
stay last. Sorting persists across pagination and automatic refreshes. The client
fetches all history pages when sorting, using the existing owner-scoped API.

Install the pinned evaluator with `uv sync --extra eval` (or add
`lm-eval==0.4.13` to the server environment). Finished studio run details have a
**Run benchmarks** button. Core covers SciQ, ARC-Easy, PIQA, HellaSwag and all
67 BLiMP phenomena; TinyLM adds LAMBADA; Extended adds WinoGrande and BoolQ.
Smoke mode uses ten examples per leaf task and is explicitly not a full benchmark.
Full mode uses the official evaluation splits. Both use zero shots and seed 42.

The byte checkpoint adapter scores every continuation byte with its maximal
available sliding context; an empty context is prefixed with byte 32 (space).
Results record checkpoint SHA-256, HF dataset commit revisions, sample digests,
harness/task versions, sample counts, context limitations and checkpoint training
byte tokens. This byte protocol is not interchangeable with a subword model's
protocol. A short-context studio model cannot exercise LAMBADA's long context.

TinyScore is the equal-weight mean chance-normalized **raw accuracy** over the
five Core tasks. Random baselines use the actual number of choices, including
ARC examples with non-four-way choices. BLiMP is a macro-average over phenomena.
Negative scores are retained. LAMBADA has no fixed-choice random baseline and is
reported separately. Length-normalized accuracy, where supplied by the harness,
and LAMBADA perplexity remain available in the detailed results.

One UI-started evaluation runs at a time in an isolated CPU subprocess. It can be
cancelled and has a two-hour limit. Restarting the app marks interrupted jobs as
failed unless a matching external Linux worker is still running; its PID and
evaluation ID are verified before preserving it. Partial results are retained but
missing Core tasks do not produce TinyScore. Public run details expose aggregate
benchmark results, never benchmark documents or private training data.

Scaling milestones are 10M, 30M, 100M, 300M and 1B training tokens. Evaluating an
old final checkpoint cannot recover earlier model states. Current results record
the saved checkpoint's actual byte-token budget and a labeled `6*N*D` FLOP estimate;
the app does not fabricate a scaling curve from one checkpoint.

See [dataset-selection.md](docs/dataset-selection.md) for the proposed Polish
20-point corpus recipe and primary-source references. The studio represents the
20 points as colored books; source identity determines category, with no editable
category dropdown. Imported corpus integration is separate from the short built-in
workflow examples.


## Real corpus starter library

The generated three-paragraph fixtures are hidden from the studio once a real
corpus pack is installed. They remain stored to reproduce old runs. The initial
pack contains 10,011 whole documents / 28,409,252 UTF-8 bytes across ten sources:
Polish FineWeb2, cleaned Polish HPLT, Wikipedia, Wikisource, Wikivoyage, Wikibooks,
Wolne Lektury, Biblioteka Nauki, EUR-Lex and parliamentary text. These are bounded
workflow samples, not complete or statistically representative corpora.

`docs/corpus-samples.json` records source revisions, sample hashes and counts.
The server retains per-document IDs, hashes, rights/attribution metadata and sample
text under `corpus-samples/`, outside Git. Existing datasets are never overwritten.
The UI's categories and colors come from source identity, not a user dropdown.

```bash
uv run --extra eval python scripts/build_corpus_samples.py /tmp/corpus-pack
uv run --extra eval python scripts/update_corpus_catalog.py /tmp/corpus-pack
uv run python scripts/import_corpus_samples.py /tmp/corpus-pack
```

Building samples streams Parquet rows until the requested per-source byte budget
(up to 512 MB), or reads the first 100 untruncated HF Viewer rows for sources
without a practical Parquet stream. The Viewer path remains a preview only.
The builder preserves entire selected documents and records the sampling method.
The import validates every text hash before its transaction and backs up SQLite.
Production imports must retain the complete pack for provenance and recovery.

For a larger local pack, run `uv run --extra eval python scripts/build_corpus_samples.py
/tmp/corpus-pack --max-mb 100`, then update the catalog and import it. The pack is
stored outside Git; its hashes and pinned HF revisions are retained in the catalog.

The Chinchilla panel calculates D≈20N and C≈6ND in both directions, with 8/16/32/64/
128M parameter presets. On RunPod it selects the actual GPU model; in CPU mode
it plans scale without changing the CPU model
or turn corpus estimates into downloaded training data.

The literary sources were expanded to approximately 12 MB each. Rebuild selected
DynaWord sources with `--max-mb 12 --sources wolne_lektury wikisource`; import and
update the catalog as above. Previous immutable dataset IDs remain available to
old runs, and the studio migrates their assigned points to the expanded sources.
Existing browser drafts migrate once to the 20x training budget. Later explicit
manual-budget choices persist. The scaling calculator accepts training tokens in
millions while storing full integer token counts in the run payload.

## RunPod training

The studio can dispatch 8M/16M/32M/64M/128M byte-level causal transformers to
`dawidmkrk/dmpod-gpt:1.0`. The Track worker uses CUDA/PyTorch in this DMPod
environment and retains the native checkpoint format; it does not invoke the
separate DMPod nanoGPT CLI. Exact parameter counts are exposed by
`GET /api/training/capabilities` and verified by the GPU worker.

Set `FABRYKA_RUNPOD_API_KEY` and a comma-separated `FABRYKA_RUNPOD_ALLOWED_USERS`
on the server. GPU access defaults to disabled. Allowed accounts default to GPU
in the studio; existing explicit compute choices persist. CPU remains selectable
for Tiny/Small workflow tests. Larger presets are rejected on CPU.

Each GPU run gets its own pod. The controller defaults to 50 parallel pods,
500 outstanding GPU jobs globally and five per user. Excess runs remain queued;
queue time does not consume their runtime budget. CPU admission is separate.
Configure `FABRYKA_RUNPOD_MAX_PARALLEL`, `FABRYKA_RUNPOD_MAX_PENDING`, and
`FABRYKA_RUNPOD_MAX_PENDING_PER_USER` to change these limits.
`FABRYKA_RUNPOD_CONTROLLER_WORKERS` (default 16) bounds concurrent provider calls.
Provisioning pods and pods awaiting confirmed deletion occupy capacity slots.

Run exactly one API/supervisor process (one Uvicorn worker, one replica): capacity
reservations and submission limits use process-local locks. GPU compute scales
across pods; adding API replicas requires a distributed scheduler lock first.
At 50 pods and the configured $0.50 per-pod hourly cap, the aggregate ceiling is
$25/hour after price checks. Provider availability, account quotas and credit
balance can reduce actual concurrency. Price is checked after allocation, so
this is not a provider-enforced total spending limit.

GPU type, cloud, hourly price cap
and maximum wall time are operator settings; the runtime includes provisioning
and synchronization. Early stopping or the time cap can end before the requested
token budget. Byte tokens are not subword tokens. The selected corpus can repeat;
the reuse estimate remains visible before launch.

Run-scoped credentials authorize only that run's recipe, selected source content,
metrics, and bounded artifact uploads. The RunPod key is never sent to the pod or
browser. A pinned worker bundle and every source/checkpoint have SHA-256 hashes.
`gpu_jobs` persists pod identity, heartbeat, deadline and cleanup state. An
uncertain create is reconciled by deterministic pod name rather than retried.
After verified uploads, the controller deletes the pod before marking the run
finished. Failed deletions retry across application restarts. An API outage can
delay deletion; pending cleanup remains visible and occupies its capacity slot.

A failed or cancelled worker uploads available diagnostics and any saved model.
A startup failure may produce only the controller's failure log. Interrupted GPU
training cannot resume from optimizer state; checkpoints are selected by best
validation loss, with actual completed steps and tokens recorded.

The web UI uses document navigation at `/new`, `/runs`, `/checkpoints`, `/run/<id>`,
`/compare/<ids>`, `/benchmarks`, `/leaderboard`, `/guide`, `/login` and `/account`.
Legacy hash bookmarks redirect to these pages.

Transient RunPod allocation failures retry for up to one hour, configurable with
`FABRYKA_RUNPOD_ALLOCATION_WAIT_SECONDS`. Retries reconcile provider state first
and use exponential cooldown with jitter; waiting does not guarantee capacity.

The target Training Suit architecture and its implementation boundaries are in
[docs/training-suit-architecture.md](docs/training-suit-architecture.md) and
[docs/training-suit-implementation.md](docs/training-suit-implementation.md).

The [fast English diagnostic ladder](docs/fast-ladder.md) reports held-out NLL/BPB,
BLiMP margins, Supplement and ARC-Easy likelihoods alongside the original TinyScore.
EWoK requires approved Hugging Face dataset access; the combined score remains
unavailable until all five components are measured. Use full mode for the fixed
sample sizes; smoke mode checks execution only.

### Public datasets and training experiments

The Studio supports public Hugging Face imports with previews, text/column filters, bounded sampling and pinned provenance, including decoding NVIDIA ClimbMix. It also offers a trapezoidal learning-rate schedule and automatic full background evaluation after successful training. See [the import and evaluation guide](docs/huggingface-datasets.md) for limits, API behavior and reproducible comparisons.

### Remote goal engine

Open `/goal` for the canonical [RFC PR #5](https://github.com/slayerlabs/rfcs/pull/5). The existing `/status` prototype can show progress, answer blockers, and stop work. Track owns the durable goal history; an agent runtime on a separate machine claims work through the scoped engine API. See [the engine setup and adapter protocol](docs/goal-engine.md).
