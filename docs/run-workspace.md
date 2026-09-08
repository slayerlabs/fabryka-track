# Research workspace and checkpoint samples

Run charts have custom controls, synchronized step inspection, searchable metrics,
EMA plus raw curves, run visibility, range focus, PNG export and a dense comparison
workspace. Benchmarks has a navbar route, queue controls and paginated owner history.
Smoke results are explicitly diagnostic, not a reliable quality ranking.

Finished studio runs expose an owner-only Sample generations tab. Prompts continue
through the actual saved native byte model. Temperature zero is greedy; other values
use top-K sampling with a recorded seed. Responses include checkpoint SHA256, saved
step, context size, raw output bytes and decoding settings. UTF-8 replacement characters
are disclosed. Requests are bounded to 512 output bytes, one process at a time per
web process, with a 90-second timeout. This is text completion, not instruction tuning.

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
