import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, type Point } from "./RunData";

export const palette = [
  "#b35236",
  "#477f72",
  "#5e80bf",
  "#ae76ac",
  "#bc943f",
  "#609cad",
  "#8e9b4e",
  "#a16d68",
  "#7b6bb0",
  "#4a9584",
];
export type Series = {
  id?: string;
  name: string;
  color?: string;
  points: Point[];
};
type Trace = {
  x: number[];
  y: number[];
  customdata: number[][];
  name: string;
  line: { color: string; width: number };
  visible: boolean;
  hoverinfo: string;
  [key: string]: unknown;
};
type HoverPoint = { x: number; y: number; customdata?: number[]; data: Trace };
type HoverEvent = { points: HoverPoint[]; event?: Event };
type Canvas = HTMLDivElement & {
  on?: (name: string, callback: (event: HoverEvent) => void) => void;
  removeListener?: (
    name: string,
    callback: (event: HoverEvent) => void,
  ) => void;
};
type PlotlyAPI = {
  react: (
    canvas: HTMLElement,
    traces: Trace[],
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<void>;
  purge: (canvas: HTMLElement) => void;
  downloadImage: (
    canvas: HTMLElement,
    options: Record<string, unknown>,
  ) => Promise<void>;
  Plots: { resize: (canvas: HTMLElement) => void };
  Fx: {
    hover: (
      canvas: HTMLElement,
      point: { xval: number },
      axes: string[],
    ) => void;
    unhover: (canvas: HTMLElement) => void;
  };
};
// The application loads the local Plotly bundle before mounting React.
const plotlyWindow = window as unknown as { Plotly: PlotlyAPI };
const plotly = () => plotlyWindow.Plotly;
const chartPeers = new Set<{
  canvas: Canvas;
  sync: (x: number) => void;
  clear: () => void;
}>();
const labels: Record<string, string> = {
  "throughput/tokens_sec": "Tokens / sec",
  "training/tokens_seen": "Training tokens",
  "train/loss": "Training loss",
  "val/loss": "Validation loss",
  "val/perplexity": "Perplexity",
  "optimizer/learning_rate": "Learning rate",
  "optimizer/gradient_norm": "Gradient norm",
  "checkpoint/tokens": "Checkpoint tokens",
  "checkpoint/step": "Checkpoint step",
};
const emptyHidden = new Set<string>();
export function RunChart({
  series,
  range = 0,
  hidden = emptyHidden,
}: {
  series: Series[];
  range?: number;
  hidden?: Set<string>;
}) {
  const canvas = useRef<Canvas>(null);
  const root = useRef<HTMLDivElement>(null);
  const allPoints = series.flatMap((s) => s.points);
  const [axis, setAxis] = useState(
    allPoints.length && allPoints.every((p) => Number.isFinite(p.tokens))
      ? "tokens"
      : "step",
  );
  const [scale, setScale] = useState(
    series.length === 1 && /perplexity/i.test(series[0].name)
      ? "log"
      : "linear",
  );
  const [smooth, setSmooth] = useState(0);
  const [drag, setDrag] = useState("zoom");
  const [reset, setReset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [muted, setMuted] = useState(new Set<string>());
  const [hover, setHover] = useState<HoverPoint[]>([]);
  const [error, setError] = useState("");
  const traces = useMemo(() => {
    const output: Trace[] = [];
    for (const [index, s] of series.entries()) {
      const points = s.points.filter(
        (p) => Number.isFinite(p.value) && (scale !== "log" || p.value > 0),
      );
      const origin = s.points.find((p) => p.timestamp)?.timestamp;
      const x = points.map((p) =>
        axis === "tokens"
          ? (p.tokens ?? p.step)
          : axis === "elapsed" && origin && p.timestamp
            ? (Date.parse(p.timestamp) - Date.parse(origin)) / 1000
            : p.step,
      );
      let average: number | undefined;
      const raw = points.map((p) => p.value);
      const y = raw.map(
        (v) =>
          (average =
            average === undefined ? v : smooth * average + (1 - smooth) * v),
      );
      const key = s.id || s.name;
      const base: Trace = {
        type: "scatter",
        mode: points.length === 1 ? "markers" : "lines",
        x,
        y,
        customdata: points.map((p) => [p.step, p.value]),
        name: labels[s.name] || s.name,
        legendgroup: key,
        line: { color: s.color || palette[index % palette.length], width: 1.8 },
        visible: !hidden.has(key) && !muted.has(key),
        hoverinfo: "none",
        showlegend: false,
      };
      if (smooth)
        output.push({
          ...base,
          y: raw,
          uid: key + "-raw",
          opacity: 0.17,
          hoverinfo: "skip",
        });
      output.push({ ...base, uid: key });
    }
    return output;
  }, [series, scale, axis, smooth, hidden, muted]);
  const latestState = useRef({ axis, traces });
  latestState.current = { axis, traces };
  useEffect(() => {
    const el = canvas.current!;
    let disposed = false;
    const peer = {
      canvas: el,
      sync: (x: number) => {
        if (
          latestState.current.axis !== "step" ||
          !root.current?.getClientRects().length
        )
          return;
        plotly().Fx.hover(el, { xval: x }, ["xy"]);
        setHover(
          latestState.current.traces
            .filter((t) => t.visible && t.hoverinfo !== "skip" && t.x.length)
            .map((t) => {
              const i = t.x.reduce(
                (best, value, index) =>
                  Math.abs(value - x) < Math.abs(t.x[best] - x) ? index : best,
                0,
              );
              return {
                x: t.x[i],
                y: t.y[i],
                data: t,
                customdata: t.customdata[i],
              };
            }),
        );
      },
      clear: () => {
        setHover([]);
        plotly().Fx.unhover(el);
      },
    };
    chartPeers.add(peer);
    const onHover = (event: HoverEvent) => {
      const points = event.points.filter((p) => p.data.hoverinfo !== "skip");
      setHover(points);
      if (event.event && latestState.current.axis === "step" && points.length)
        for (const other of chartPeers)
          if (other !== peer) other.sync(points[0].x);
    };
    const onUnhover = () => setHover([]);
    // Plotly attaches its event-emitter methods after its first render.
    const attach = () => {
      if (disposed) return;
      if (el.on) {
        el.on("plotly_hover", onHover);
        el.on("plotly_unhover", onUnhover);
      } else frame = requestAnimationFrame(attach);
    };
    let frame = requestAnimationFrame(attach);
    const observer = new ResizeObserver(() => {
      if (el.on && el.getClientRects().length) plotly().Plots.resize(el);
    });
    observer.observe(el);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      chartPeers.delete(peer);
      el.removeListener?.("plotly_hover", onHover);
      el.removeListener?.("plotly_unhover", onUnhover);
      plotly().purge(el);
    };
  }, []);
  useEffect(() => {
    const el = canvas.current!;
    let cancelled = false;
    const xaxis: Record<string, unknown> = {
      title: {
        text:
          axis === "tokens"
            ? "Training tokens"
            : axis === "elapsed"
              ? "Elapsed time · seconds"
              : "Step",
      },
      gridcolor: "#d6dfd4",
      zeroline: false,
      showline: true,
      linecolor: "#d6dfd4",
      nticks: 6,
      exponentformat: "SI",
      showspikes: true,
      spikemode: "across",
      spikesnap: "cursor",
      spikethickness: 1,
      spikedash: "dot",
      spikecolor: "#78828b",
    };
    const yaxis: Record<string, unknown> = {
      type: scale,
      gridcolor: "#d6dfd4",
      zeroline: false,
      nticks: 5,
      exponentformat: "SI",
      automargin: true,
    };
    if (range) {
      let xmax = -Infinity;
      for (const t of traces)
        if (t.visible) for (const x of t.x) xmax = Math.max(xmax, x);
      const xmin = xmax * range;
      const ys = traces
        .filter((t) => t.visible)
        .flatMap((t) => t.y.filter((_, i) => t.x[i] >= xmin))
        .filter((y) => scale !== "log" || y > 0)
        .map((y) => (scale === "log" ? Math.log10(y) : y));
      if (ys.length) {
        let min = Infinity,
          max = -Infinity;
        for (const y of ys) {
          min = Math.min(min, y);
          max = Math.max(max, y);
        }
        const pad = (max - min || Math.abs(max) * 0.1 || 1) * 0.12;
        xaxis.range = [xmin, xmax];
        xaxis.autorange = false;
        yaxis.range = [min - pad, max + pad];
        yaxis.autorange = false;
      }
    }
    plotly()
      .react(
        el,
        traces,
        {
          height: expanded ? Math.max(300, innerHeight * 0.9 - 170) : 285,
          margin: { l: 52, r: 20, t: 20, b: 42 },
          autosize: true,
          paper_bgcolor: "#f8f9f5",
          plot_bgcolor: "#f8f9f5",
          font: {
            family: getComputedStyle(el).fontFamily,
            size: 11,
            color: "#9298a1",
          },
          hovermode: "x",
          dragmode: drag,
          uirevision: `${axis}:${scale}:${reset}:${range}`,
          showlegend: false,
          xaxis,
          yaxis,
          annotations: traces.some((t) => t.x.length)
            ? []
            : [
                {
                  text: "Waiting for measurements",
                  xref: "paper",
                  yref: "paper",
                  x: 0.5,
                  y: 0.5,
                  showarrow: false,
                },
              ],
        },
        {
          responsive: true,
          displaylogo: false,
          scrollZoom: false,
          displayModeBar: false,
        },
      )
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [traces, axis, scale, reset, range, expanded, drag]);
  return (
    <div
      ref={root}
      className={"interactive-chart" + (expanded ? " plot-expanded" : "")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSettings(false);
          setExpanded(false);
        }
      }}
      onMouseLeave={() => {
        for (const peer of chartPeers) peer.clear();
      }}
    >
      <div className="plot-toolbar">
        <span className="plot-count">
          {Math.max(0, ...series.map((s) => s.points.length)).toLocaleString()}{" "}
          measurements{smooth ? ` · EMA ${smooth}` : ""}
        </span>
        <div className="plot-actions">
          <button
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => setReset((n) => n + 1)}
          >
            ↺
          </button>
          <button
            aria-label="Download chart as PNG"
            title="Download PNG"
            onClick={() => {
              void plotly()
                .downloadImage(canvas.current!, {
                  format: "png",
                  filename: "fabryka-metrics",
                  width: 1400,
                  height: 700,
                  scale: 2,
                })
                .catch((e) => setError(String(e)));
            }}
          >
            ↓
          </button>
          <button
            aria-label={expanded ? "Close expanded chart" : "Expand chart"}
            onClick={() => {
              setSettings(false);
              setExpanded((v) => !v);
            }}
          >
            {expanded ? "×" : "⤢"}
          </button>
          <button
            aria-label="Chart controls"
            aria-expanded={settings}
            onClick={() => setSettings((v) => !v)}
          >
            ☷
          </button>
        </div>
      </div>
      <div className="plot-settings" hidden={!settings}>
        <div className="plot-settings-title">
          Chart controls{" "}
          <button
            aria-label="Close chart controls"
            onClick={() => setSettings(false)}
          >
            ×
          </button>
        </div>
        <label>
          X axis
          <select
            aria-label="X axis"
            value={axis}
            onChange={(e) => setAxis(e.target.value)}
          >
            <option value="step">Step</option>
            <option
              value="elapsed"
              disabled={!allPoints.some((p) => p.timestamp)}
            >
              Elapsed time
            </option>
            {allPoints.length > 0 &&
              allPoints.every((p) => Number.isFinite(p.tokens)) && (
                <option value="tokens">Training tokens</option>
              )}
          </select>
        </label>
        <label>
          Y axis
          <select
            aria-label="Y axis scale"
            value={scale}
            onChange={(e) => setScale(e.target.value)}
          >
            <option value="linear">Linear</option>
            <option value="log">Logarithmic</option>
          </select>
        </label>
        <label>
          Interaction
          <select
            aria-label="Chart interaction"
            value={drag}
            onChange={(e) => setDrag(e.target.value)}
          >
            <option value="zoom">Box zoom</option>
            <option value="pan">Pan</option>
          </select>
        </label>
        <label className="plot-smoothing">
          Smoothing <output>{smooth}</output>
          <input
            aria-label="Exponential smoothing"
            type="range"
            min="0"
            max="0.99"
            step="0.01"
            value={smooth}
            onChange={(e) => setSmooth(Number(e.target.value))}
          />
        </label>
        <small>
          Exponential moving average. Raw measurements remain visible.
        </small>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div
        ref={canvas}
        className="plot-canvas"
        role="img"
        aria-label="Interactive training metrics"
      />
      <div className="plot-tooltip" hidden={!hover.length}>
        <div className="plot-tooltip-head">
          STEP <b>{fmt(hover[0]?.customdata?.[0] ?? hover[0]?.x, 4)}</b>
          {smooth > 0 && <span>EMA · raw</span>}
        </div>
        {hover.map((p, i) => (
          <div key={i} className="plot-tooltip-row">
            <i style={{ background: p.data.line.color }} />
            <span>{p.data.name}</span>
            <b>{fmt(p.y, 4)}</b>
            {smooth > 0 && <small>{fmt(p.customdata?.[1], 4)}</small>}
          </div>
        ))}
      </div>
      <div className="plot-legend">
        {series.map((s, i) => {
          const key = s.id || s.name;
          const off = hidden.has(key) || muted.has(key);
          return (
            <button
              key={key}
              className={"plot-series" + (off ? " is-muted" : "")}
              aria-pressed={!off}
              title={"Toggle " + s.name}
              onClick={() =>
                setMuted((previous) => {
                  const next = new Set(previous);
                  next.has(key) ? next.delete(key) : next.add(key);
                  return next;
                })
              }
            >
              <span
                className="plot-swatch"
                style={{ background: s.color || palette[i % palette.length] }}
              />
              <span>{labels[s.name] || s.name}</span>
              <b>{fmt(s.points.at(-1)?.value, 4)}</b>
            </button>
          );
        })}
      </div>
    </div>
  );
}
