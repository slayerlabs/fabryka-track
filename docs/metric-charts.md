# Metric charts

The run and comparison explorer uses Matplotlib/Agg to render scatter plots.
Recorded points are never joined by interpolation lines. The initial x domain
fits the visible measurements with a small margin, including resumed runs that
begin at a large step. Range filters use the recorded span rather than the
distance from step zero. A single point and constant-valued metrics receive
nonzero, useful axis margins.

Browser controls retain point inspection, box zoom, pan, reset, linear/log scale,
step/tokens/elapsed axes, optional EMA points, series visibility and PNG download.
Time axes share one origin across series. Raw measurements remain visible when
EMA is enabled. Axis geometry returned with each PNG maps browser interactions
to the same data coordinates used by Matplotlib.

`POST /api/charts/render` accepts bounded finite series already available to the
browser. It reads no experiment data itself, modifies no records and writes no
images or datasets to disk. The renderer uses a dedicated single worker and a
bounded queue, following Matplotlib's thread-safety guidance. A 64-entry memory
cache reuses identical images; offscreen charts render lazily and unchanged
poll results do not cause redraws. Downloads use the displayed PNG.

The educational loss/validation/test/perplexity panels have been removed from
the run, leaderboard and benchmark screens. The run's gradient tutorial and
chart-reading link are also removed; actual metrics and chart controls remain.

## Loss views and smoothing

Training loss and validation loss have separate panels. Validation and perplexity default to raw dots, avoiding the lag of a long EMA over infrequent evaluations. Training loss retains faint raw points and an adjustable EMA. For points with actual token coordinates, the visible control sets a half-life of 25M–1B tokens (100M by default), or Off. The retention between observations is `2**(-delta_tokens / half_life)`; the first observation and each continuation phase start with their raw value. Repeated observations at one token position keep all raw dots and use the latest value for the trend. Without token coordinates, the coefficient-based normalized EMA remains available. Fewer than five observations remain raw.

Token coordinates come from the point itself or token metrics logged at the exact same step. The dashboard never extrapolates from planned budgets or assumes an unlogged batch size. Token axes use billions when the range is large. Core GPU telemetry defaults to elapsed time and raw dots; learning-rate plots also default to raw values. Raw hover and legend values remain available and PNG exports match the displayed plot.

## Optional improvement views

Use **Show improvement views** on a run to reveal two additional panels:

- **Recent improvement** subtracts each validation loss from a selectable reference evaluation. Positive values mean lower loss than that reference. This uses cross-entropy, not perplexity differences.
- **Learning speed** fits a trailing ordinary least-squares line to 3, 5, 7 (default), or 9 distinct validation positions. X values are actual tokens divided by one billion; the displayed rate is the negative fitted slope. Positive means falling loss, zero means a flat fitted trend, and negative means rising loss.

Windows require their full number of distinct observations. Duplicate evaluations at a token position use the latest observation and do not gain extra weight. Fits stop at missing token positions, non-increasing token counts and the declared continuation boundary. Original and continued phases are never fit together. When a continuation lacks enough evaluations, its count and required window are displayed; historical estimates remain visible. The fitted series gets no second EMA. Both diagnostics include a zero reference line and keep signed values on a linear scale.

These are display diagnostics, not statistical confidence intervals or evidence that a tiny gain is real. Compare checkpoints on the same fixed validation examples to assess real progress. The plots never modify stored metrics, weights or optimizer settings.
