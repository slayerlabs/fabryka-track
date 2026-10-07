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
