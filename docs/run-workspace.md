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
