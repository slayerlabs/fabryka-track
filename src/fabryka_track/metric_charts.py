"""Bounded, in-memory Matplotlib scatter rendering for the metric explorer."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from io import BytesIO
import math
from threading import BoundedSemaphore
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from matplotlib.ticker import FuncFormatter, MaxNLocator, NullLocator, ScalarFormatter
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator

router = APIRouter(prefix='/api/charts')
Number = Annotated[FiniteFloat, Field(gt=-1e100, lt=1e100)]


class ChartSeries(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(max_length=200)
    color: str = Field(pattern=r'^#[a-fA-F0-9]{6}$')
    x: list[Number] = Field(max_length=20_000)
    y: list[Number] = Field(max_length=20_000)
    alpha: float = Field(default=1., ge=.05, le=1.)
    # 'checkpoints': one evaluation per checkpoint (a few points per run). Drawn as connected markers with the
    # latest value labelled, so two or three results do not read as an empty grid.
    kind: Literal['points', 'trend', 'checkpoints'] = 'points'

    @model_validator(mode='after')
    def paired(self):
        if len(self.x) != len(self.y):
            raise ValueError('Each x coordinate needs one y value.')
        return self


class ChartInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    series: list[ChartSeries] = Field(max_length=20)
    width: int = Field(default=500, ge=240, le=1600)
    height: int = Field(default=285, ge=200, le=900)
    axis: Literal['step', 'tokens', 'elapsed'] = 'step'
    scale: Literal['linear', 'log'] = 'linear'
    skip: float = Field(default=0., ge=0., le=.99)
    xlim: tuple[Number, Number] | None = None
    ylim: tuple[Number, Number] | None = None
    boundary: Number | None = None
    planned_x: Number | None = Field(default=None, gt=0)  # planned end of the run on the x axis (e.g. config.steps)
    # Smallest y-axis span for linear plots, centred on the data (e.g. .05 for accuracies, so a 1.6 pp change
    # between two checkpoints does not fill the whole height).
    y_min_span: Number | None = Field(default=None, gt=0)
    zero_line: bool = False
    ylabel: str = Field(default='', max_length=100)

    @model_validator(mode='after')
    def bounded(self):
        if sum(len(s.x) for s in self.series) > 50_000:
            raise ValueError('Render at most 50,000 measurements at once.')
        for bounds in (self.xlim, self.ylim):
            if bounds and bounds[0] >= bounds[1]:
                raise ValueError('Axis bounds must increase.')
        if self.scale == 'log' and (any(y <= 0 for s in self.series for y in s.y) or
                                  self.ylim and self.ylim[0] <= 0):
            raise ValueError('Logarithmic plots need positive values.')
        return self


def padded(low, high):
    padding = (high - low) * .06 if high != low else max(abs(low) * .00001, 1.)
    return low - padding, high + padding


def build_figure(spec):
    figure = Figure(figsize=(spec.width / 100, spec.height / 100), dpi=200, facecolor='#fdfbf9')
    FigureCanvasAgg(figure)
    ax = figure.subplots()
    figure.subplots_adjust(left=min(.29, 78 / spec.width), right=.975, bottom=.22, top=.95)
    ax.set_facecolor('#fdfbf9')
    xs = [x for s in spec.series for x in s.x]
    if spec.xlim:
        xlim = spec.xlim
    elif xs:
        low, high = min(xs), max(xs)
        planned = spec.planned_x is not None and spec.planned_x >= high
        if planned:
            high = spec.planned_x
        low += (high - low) * spec.skip
        xlim = padded(low, high)
        if planned:  # the planned end is the edge of the chart, with a thin margin for its marker
            xlim = xlim[0], high + (high - low) * .02
        if min(xs) > 0:  # a measurement at exactly 0 keeps the left margin instead of sitting cut on the axis
            xlim = max(0, xlim[0]), xlim[1]
    else:
        xlim = (0., 1.)
    ax.set_xlim(xlim)
    checkpoints = [s for s in spec.series if s.kind == 'checkpoints']
    for s in spec.series:
        if s.kind == 'trend':
            pairs = list(zip(s.x, s.y))
            parts = [pairs]
            if spec.boundary is not None:
                parts = [[p for p in pairs if p[0] <= spec.boundary],
                         [p for p in pairs if p[0] > spec.boundary]]
            for part in parts:
                if part:
                    x, y = zip(*part)
                    ax.plot(x, y, color=s.color, alpha=s.alpha, linewidth=1.4,
                            marker='o' if len(part) == 1 else None, markersize=2.5)
        elif s.kind == 'checkpoints':
            pairs = sorted(zip(s.x, s.y))
            if pairs:
                x, y = zip(*pairs)
                ax.plot(x, y, color=s.color, alpha=s.alpha * .55, linewidth=1.1, zorder=2)
                ax.scatter(x, y, s=26, color=s.color, alpha=s.alpha, linewidths=0, zorder=3)
                # Fixed precision so values from one chart compare at a glance; near the right edge the label
                # goes to the left of the point to stay inside the tile.
                label = f'{y[-1]:.3f}' if abs(y[-1]) < 10 else f'{y[-1]:,.1f}'
                right = (x[-1] - xlim[0]) > .85 * (xlim[1] - xlim[0])
                ax.annotate(label, (x[-1], y[-1]), xytext=(-5 if right else 5, 5), textcoords='offset points',
                            ha='right' if right else 'left', fontsize=7.5, color=s.color, annotation_clip=True)
        else:
            # Raw measurements are never connected.
            ax.scatter(s.x, s.y, s=13, color=s.color, alpha=s.alpha, linewidths=0)
    ys = [y for s in spec.series for x, y in zip(s.x, s.y) if xlim[0] <= x <= xlim[1]]
    if spec.zero_line and spec.scale == 'linear':
        ax.axhline(0, color='#81776e', linewidth=.9, linestyle='--')
        ys.append(0.)
    if spec.scale == 'log':
        ax.set_yscale('log')
    if spec.ylim:
        ax.set_ylim(spec.ylim)
    elif ys:
        low, high = min(ys), max(ys)
        if spec.scale == 'log':
            low, high = math.log10(low), math.log10(high)
        # Sparse checkpoint results get more headroom: two values should not span the whole axis.
        share = .25 if checkpoints else .08
        padding = (high - low) * share if high != low else (
            max(abs(low) * .04, .02) if spec.scale == 'log' else (abs(low) * .05 or 1.))
        low, high = low - padding, high + padding
        if spec.y_min_span and spec.scale == 'linear' and high - low < spec.y_min_span:
            middle = (low + high) / 2
            low, high = middle - spec.y_min_span / 2, middle + spec.y_min_span / 2
        ax.set_ylim((10 ** low, 10 ** high) if spec.scale == 'log' else (low, high))
    elif spec.scale == 'log':
        ax.set_ylim(1., 10.)
    else:
        ax.set_ylim(0., 1.)
    if not xs:
        ax.text(.5, .5, 'Waiting for measurements', transform=ax.transAxes,
                ha='center', va='center', color='#81776e', fontsize=9)
    billions = spec.axis == 'tokens' and max(abs(xlim[0]), abs(xlim[1])) >= 1e9
    ax.set_xlabel({'step': 'Step', 'tokens': 'Training tokens · billions' if billions else 'Training tokens', 'elapsed': 'Elapsed time · seconds'}[spec.axis],
                  fontsize=9, color='#6f675f', labelpad=8)
    if spec.ylabel:
        ax.set_ylabel(spec.ylabel, fontsize=8, color='#6f675f', labelpad=7, parse_math=False)
    ax.tick_params(axis='both', labelsize=8, colors='#81776e', length=0, pad=5)
    ax.xaxis.set_major_locator(MaxNLocator(nbins=5, integer=spec.axis == 'step'))
    formatter = ScalarFormatter(useOffset=False)
    formatter.set_powerlimits((-4, 6))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, position: f'{value / 1e9:g}') if billions else formatter)
    if spec.scale == 'linear':
        ax.yaxis.set_major_locator(MaxNLocator(nbins=5))
        formatter = ScalarFormatter(useOffset=False)
        formatter.set_powerlimits((-4, 6))
        ax.yaxis.set_major_formatter(formatter)
    else:
        formatter = ScalarFormatter(useOffset=False)
        if ax.get_ylim()[1] / ax.get_ylim()[0] < 100:
            ax.yaxis.set_major_locator(MaxNLocator(nbins=5))
            ax.yaxis.set_minor_locator(NullLocator())
        ax.yaxis.set_major_formatter(formatter)
        ax.yaxis.set_minor_formatter(formatter)
        ax.tick_params(which='minor', labelsize=8, colors='#81776e', length=0)
    ax.grid(True, color='#ded8d0', linewidth=.6)
    if spec.boundary is not None and xlim[0] <= spec.boundary <= xlim[1]:
        ax.axvline(spec.boundary, color='#81776e', linestyle='--', linewidth=.8)
        ax.text(spec.boundary, .98, 'continuation  ', transform=ax.get_xaxis_transform(),
                fontsize=7, color='#81776e', va='top', ha='right', clip_on=True)
    if spec.planned_x is not None and xlim[0] <= spec.planned_x <= xlim[1]:
        ax.axvline(spec.planned_x, color='#81776e', linestyle='--', linewidth=.8)
        ax.text(spec.planned_x, .98, 'end of run  ', transform=ax.get_xaxis_transform(),
                fontsize=7, color='#81776e', va='top', ha='right', clip_on=True)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color('#ded8d0')
        spine.set_linewidth(.6)
    return figure, ax


# Matplotlib artists are not thread-safe. A dedicated single worker serializes
# rendering without taking the API's normal thread pool. Bound queued requests.
_renderer = ThreadPoolExecutor(max_workers=1, thread_name_prefix='metric-chart')
_slots = BoundedSemaphore(8)


@lru_cache(maxsize=64)
def render_chart(encoded):
    spec = ChartInput.model_validate_json(encoded)
    figure, ax = build_figure(spec)
    buffer = BytesIO()
    figure.savefig(buffer, format='png', dpi=200, facecolor=figure.get_facecolor())
    bounds = ax.get_position()
    result = {'image': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(),
              'axes': [bounds.x0, 1 - bounds.y1, bounds.width, bounds.height],
              'xlim': list(ax.get_xlim()), 'ylim': list(ax.get_ylim()), 'renderer': 'matplotlib'}
    figure.clear()
    return result


@router.post('/render')
async def render(spec: ChartInput):
    # Inputs are series already readable by the browser. This endpoint reads no
    # database records and stores no images or dataset payloads on disk.
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, 'Chart renderer is busy. Try again shortly.', headers={'Retry-After': '1'})
    future = asyncio.get_running_loop().run_in_executor(_renderer, render_chart, spec.model_dump_json())
    future.add_done_callback(lambda _: _slots.release())
    return await asyncio.shield(future)
