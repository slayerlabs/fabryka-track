# Interactive metrics and GPU scheduling

Run details and comparisons use locally served Plotly Basic 3.1.0 (MIT, license in
`static/PLOTLY-LICENSE.txt`). No metrics are sent to a chart hosting service.
Charts support box zoom, pan, unified hover, linear/log Y axes, step/elapsed X
axes, exponential smoothing with raw traces retained, legend selection, expanded
view, reset, and local PNG export. Live updates preserve zoom and controls.
Elapsed time starts at each series' first recorded measurement; it is not pod
billing duration. Log scale excludes nonpositive points.

The current-runs dashboard refreshes every five seconds; run details refresh
every two seconds. Owners can see allocation errors, queue position, GPU name,
hourly price, deadline, and ETA derived from their measured throughput. ETA is
time to the token limit, excludes artifact transfer, and can be shortened by
early stopping. Public run responses do not include private operational state.

GPU jobs queue sequentially (five outstanding jobs maximum). A failed allocation
is reconciled against the provider's pod list twice before retrying, with at most
three allocation attempts. Allocation requests include configurable fallback GPU
types; an actual price exceeding the configured hourly cap triggers termination.
Queued waiting does not consume the selected execution budget. Owners choose
1/4/12/24 hours within the operator cap and see a compute cost ceiling on review.
The cleanup lifecycle remains artifact verification followed by pod deletion.

Validation: 44 backend tests; Chrome checks using 295 actual metric samples from
run `f66fe072-91bf-499b-918d-2b13df73cb8a`, including zoom retained across polling,
log/EMA/elapsed controls, hover, expansion, PNG export and 390px mobile layout.
GPU setup was checked through review and its intercepted request (no paid test
run), including a 4-hour selection and the corresponding cost ceiling.
