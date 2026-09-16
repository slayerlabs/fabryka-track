# Published benchmark results

`/benchmark-results` is a public, read-only page for recorded checkpoint evaluations.
It updates directly from Track's database when an evaluation finishes; there is no
scraper, manually copied score table or separate deployment for new results. The
private evaluation workspace remains at `/benchmarks`.

The layout follows the benchmark/result/metric convention of model cards. Numbers
come from Track evaluations, not the BananaMind reference site. The chart and tables
use the same API records. Unmeasured benchmarks and unsupported aggregate indices
are not estimated. Full evaluations are the default; smoke tests have a separate
selector and diagnostic label, and are not ranked in a chart.

## Source and visibility

- `GET /api/benchmark-results?mode=full&limit=100&offset=0`: stable, newest-first
  pagination of finished evaluations belonging to public, finished runs. `mode`
  accepts `full` or `smoke`; `limit` is 1–100.
- `GET /api/benchmark-results/{evaluation_id}`: a single curated JSON report.
- Both endpoints are anonymous and `Cache-Control: no-store`. Making a run private
  removes it from both endpoints immediately on the next request, including for owners.
- Only allowlisted checkpoint/evaluation fields are public. Training data, model
  files, raw examples, worker leases, local paths and operational runner identifiers
  are excluded. API result downloads contain this same curated report.

## Metrics and comparison

Each measurement retains its metric key, value, unit, direction, sample count,
sample digest, dataset revisions, task versions and splits. `accuracy` maps to
`acc,none` for standard harness tasks; `acc_norm` maps to `acc_norm,none`. They appear
as separate rows. Scores of zero are preserved. Missing, failed and nonnumeric
measurements are omitted instead of displayed as zero.

Chart groups match benchmark, metric, full/smoke scope, protocol, harness version,
scoring implementation, few-shot count, seed, example count, sample digest,
dataset revisions, task versions and splits. Required missing provenance excludes
a measurement from grouped charts while retaining its table entry. Model context
length and training budget remain model properties visible in the evidence. A group
is a match on recorded settings, not a claim that measurements were independently
verified or that numerical results are hardware-independent.

Within a group, the latest measurement of each checkpoint SHA is used, not its best
historical score. The chart shows up to 12 checkpoints; tables paginate six reports
at a time and preserve the complete returned evaluation history. Bits per byte are
sorted ascending; accuracy is sorted descending. There is no aggregate across tasks.

Implementation: `published_benchmarks.py`, `frontend/src/pages/PublicPublished.tsx`
and `frontend/src/pages/PublicBenchmarkModel.ts`. Backend permission/serialization
tests are in `tests/test_published_benchmarks.py`; comparison-group regressions are
in `tests/published-benchmarks.test.mjs` and `tests/pl-leaderboard.test.mjs`.
