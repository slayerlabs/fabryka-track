# Research workspace and checkpoint samples

Run charts have custom controls, synchronized step inspection, searchable metrics,
EMA plus raw curves, run visibility, range focus, PNG export and a dense comparison
workspace. Benchmarks has a navbar route, queue controls and paginated owner history.
Smoke results are explicitly diagnostic, not a reliable quality ranking.

For Polish checkpoints the ladder exposes a separate Polish MultiBLiMP suite. It
uses the real `jumelet/multiblimp` `pol` configuration and compares byte log
probability for the grammatical sentence against its ungrammatical minimal pair.
The 50% baseline and normalized score are reported separately from the English
TinyScore. Smoke evaluates 100 pairs; full mode evaluates the complete split and
records the immutable Hugging Face revision.

Finished studio runs expose a Sample generations tab for owners and viewers of
public runs. Generation requires sign-in. Private runs remain owner-only, and making
a run private immediately prevents new generation requests from other accounts.
This grants no access to checkpoint downloads, notes, logs, namespace or editing.
The sampler runs only after submitting a prompt; opening a run does not launch work.
Prompts continue
through the actual saved native byte model. Temperature zero is greedy; other values
use top-K sampling with a recorded seed. Responses include checkpoint SHA256, saved
step, context size, raw output bytes and decoding settings. UTF-8 replacement characters
are disclosed. Requests are bounded to 512 output bytes, one process at a time per
web process, with a 90-second subprocess timeout. The worker returns partial output
with `finish_reason: "time_limit"` after its 70-second budget (checked between bytes),
so the UI can show the continuation instead of discarding it. Complete requests use
`finish_reason: "length"`. This is text completion, not instruction tuning.

`POST /api/runs/{run_id}/generate` accepts `prompt`, `max_new_bytes` (1–512),
`temperature` (0–2), `top_k` (1–256) and `seed` (0–2147483647). Browser sessions and
account API keys can sample public finished native checkpoints. Anonymous requests
return 401, private or unpublished foreign runs return 404, unavailable checkpoints
return 409, and the busy process slot returns 429. Generation does not change the
source run or persist the prompt/continuation.

The CPU decoder caches each layer's attention keys and values within the context
window. It rebuilds them once the window slides because learned absolute positions
and prefix attention have changed. Tests compare logits to full causal forwards,
including long prompts and repeated window slides. Weights and the training forward
pass are unchanged. Floating-point operation order differs from the previous decoder;
responses identify `decoder: "cached-causal-v1"` for reproducibility.

On 2026-09-15, the production VPS CPU generated 160 bytes from public 128M run
`fe988f54-6a6f-4b1c-b704-b3332459d918` in 53.929 seconds with the previous worker
and 7.133 seconds with cached decoding. Both used prompt `The purpose of science is to`,
temperature 0.8, top-K 40 and seed 42, and returned identical raw bytes. A 256-byte
sample with `Dawno temu, w małym miasteczku,` completed in 13.118 seconds. These are
individual CPU worker timings including loading and hashing, under the server's
then-current workload; they do not measure concurrent capacity or model quality.

The benchmark adapter scores growing causal prefixes in one forward pass, followed
by maximal sliding windows past the context boundary. Tests compare it against the
original bytewise likelihood calculation, including empty and long contexts. CPU is
still the default; the adapter accepts a CUDA device for remote execution.

SDK runs support path assignment, append and upload through RunField. Owner-only
namespace browsing and numeric-series cursors expose this data without requiring
fixed metric names. Metadata and series storage interfaces are separate, but the
current implementation remains SQL. No billion-point capacity or ClickHouse backend
is claimed. Studio metrics remain worker-managed. Existing full run-detail queries
still need downsampling for very large histories.

Validation: 53 backend tests; Chrome checks for comparison controls and polling,
benchmark navigation, sample request controls, safe text rendering, namespace tree
and 390px mobile layout. Three actual 8M checkpoint samples generated locally.

## Persistent GPU benchmark workers

`python -m fabryka_track.benchmark_agent` runs on a dedicated GPU host, using
`TRACK_RUNNER_TOKEN`, `TRACK_URL`, `TRACK_BENCHMARK_WORKDIR` and optionally
`TRACK_BENCHMARK_DEVICE` (default CUDA). The server's
`FABRYKA_BENCHMARK_RUNNER_TOKENS` maps worker names to independent bearer secrets.
These secrets authorize only benchmark assignment, assigned checkpoint reads and
results for the current lease. They are not user or SSH credentials.

Configured remote runners each claim one FIFO job. Local dispatch is disabled while
remote runners are configured; existing local processes retain their jobs. Heartbeats
arrive every five seconds. A disconnected agent terminates its child after 60 seconds
without acknowledgement; the server requeues expired leases after 180 seconds.
Cancellation invalidates the lease; the agent then terminates the child. Each child
has a two-hour cap. Successful task results and dataset revisions survive retries,
so resumed evaluations skip completed tasks. Runner, GPU, Torch, scoring implementation
and checkpoint hash are recorded. TF32 is disabled for evaluation.

Run one web process for claim serialization (the current deployment); horizontal
API replication needs transactional row claiming before deployment. GPU/CPU floating
point results can differ slightly; provenance records the hardware transition.

Enqueueing the same checkpoint/protocol/mode resumes the previous partial evaluation
in place. Completed tasks are retained; failed tasks are retried. A fully completed
matching suite returns its existing evaluation without creating another job. Extending
a suite copies compatible completed tasks from one coherent prior evaluation and
queues only the remainder. Smoke results are never substituted for full results.

## Runs dashboard and forks

`/runs` defaults to explicitly focused baseline/fork families. **All runs / archive**
retains every owned run; nothing is deleted by archiving. New training runs persist
focus, and queued/running/stopping runs keep their entire family visible. Existing
inactive runs are not selected arbitrarily. Focus is a workspace choice, not a
training concurrency limit. `PATCH /api/runs/{id}/focus` accepts
`{"focused": true|false}` for any owned member and updates the whole family;
archiving an active family returns 409.

Status, date and search filters apply to the table and summary cards. Select 2–10
visible runs for comparison charts. Families retain their root identity if filters
hide a parent. Forks show changes in user-controlled settings, not source-artifact
metadata. The primary target is sub-150M models and lower WikiText-2 BYTE_PPL:
https://huggingface.co/spaces/Glint-Research/Tiny-ML-Leaderboard

Quality summaries use finished **full validation** evaluations with the same
protocol. Training loss, smoke diagnostics and final-test evidence are separate.
GPU hours use recorded RunPod billing seconds, not CPU runtime or allocation
estimates. Run monitoring labels billed and estimated cost separately; unavailable
values remain absent. GPU activity counts recent running worker heartbeats, not
peak VRAM. `/api/dashboard` returns owned families, checkpoint evidence, latest
metrics and at most 40 validation-loss samples per run. Progress is a 0–1 fraction.

`/checkpoints?run=<id>` orders a run's snapshots chronologically. The page shows
steps, exact logged token counts at each snapshot when available, training loss,
artifact size, authenticated downloads and recorded evaluation SHA. The SHA
identifies evaluated bytes; it does not attest to a later overwritten download.
Native training tokens are UTF-8 bytes, not subword tokens.

Fork opens `/new?parent=<run-id>&checkpoint=<checkpoint-id>`. Retry uses the same
reviewed warm-start flow for stopped/failed runs. Multiple checkpoints open a
chooser, defaulting to the best available training-loss checkpoint. Missing or
unsupported weights are not offered as executable forks. Current trainers and
evaluators require local files; R2-only artifacts are not executable here.

The fork draft restores the original accessible datasets and exact percentages,
keeps model shape and compute fixed, and allows supported training-setting changes.
Missing datasets or incompatible model shapes block launch rather than substituting
data or architecture. The review step shows lineage. **Launch fork** creates a new
run initialized from saved weights; optimizer, schedule and step counter start fresh.
The parent and normal saved studio draft remain unchanged.

## Checkpoint-specific WikiText-2

Owners explicitly submit `POST /api/runs/{id}/benchmarks` with
`{"suite":"wikitext2","mode":"full","split":"validation","checkpoint_id":"<id>"}`.
The snapshot must belong to the run and contain available native byte-model `.pt`
weights. Periodic snapshots can be evaluated before training finishes. Omitting
the checkpoint retains the existing finished-run final-model behavior.
`mode:"smoke"` scores only ten documents and never ranks. `split:"test"` requires
an explicit confirmation in the UI; freeze checkpoint choice rather than tuning
repeatedly against that score. Opening pages or review dialogs queues nothing.

`wikitext2-v1-lmeval0413-byte-rolling` pins lm-eval 0.4.13 and
`EleutherAI/wikitext_document_level`, `wikitext-2-raw-v1`, revision
`647234772b9554e208af6c826f23b99e3cac88c8`. It uses the official detokenizer and
`get_rolling_token_windows(context_len=1)` block windows, bounded by model context.
Every target UTF-8 byte is scored once, documents reset context, and the native
model uses a space-byte prefix without EOS. Corpus BYTE_PPL is
`exp(-sum(loglikelihood) / sum(original_page_utf8_bytes))`; the denominator is
measured before detokenization. Bits per byte use the same aggregate divided by
`ln(2)`. Results record byte/document counts and a corpus digest.

This differs from the existing private Tiny-ML aggregate's maximal sliding-byte
protocol; see [private Tiny-ML comparisons](private-tiny-ml.md). Do not combine or
rank scores across the two protocols. External leaderboard entries are reported
by their authors; matching a task name does not establish numerical parity.

Queueing pins checkpoint ID, artifact ID/storage key and SHA. Claim, download and
execution verify that identity; mutation fails instead of selecting newer weights.
Only a completed evaluation with matching checkpoint, artifact, hash, protocol,
split and mode can satisfy a WikiText request. Failed/cancelled WikiText work
starts a new attempt; smoke, test and validation measurements are never reused
across those boundaries. One evaluation per run may be queued/running at a time.
Existing cancellation applies, and all WikiText results remain owner-only even
when the source run is public.

Deploy both API and existing benchmark worker source. Updated workers advertise
the WikiText and Tiny-ML protocol IDs in the claim body's `protocols` list; old
workers skip unsupported jobs. Preserve the worker's environment, idle-GPU
admission policy and resource limits. Adding this workflow provisions no GPU.
