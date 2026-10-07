import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { request } from "../provider";
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
type Axis = "step" | "tokens" | "elapsed";
type Scale = "linear" | "log";
type Bounds = [number, number];
type Viewport = { xlim?: Bounds; ylim?: Bounds };
type Trace = {
  name: string;
  color: string;
  x: number[];
  y: number[];
  points: Point[];
  alpha: number;
  kind: "points" | "trend";
  raw?: boolean;
};
type ImageFrame = {
  image: string;
  axes: [number, number, number, number];
  xlim: Bounds;
  ylim: Bounds;
  traces: Trace[];
  scale: Scale;
};
type Hover = {
  name: string;
  color: string;
  value: number;
  point: Point;
  smoothed: boolean;
};
type Drag = {
  start: [number, number];
  end: [number, number];
  mode: string;
  frame: ImageFrame;
};
const labels: Record<string, string> = {
  "throughput/tokens_sec": "Tokens / sec",
  "training/tokens_seen": "Training tokens",
  "train/loss": "Training loss",
  "val/loss": "Validation loss",
  "val/perplexity": "Perplexity",
  "optimizer/learning_rate": "Learning rate",
  "optimizer/gradient_norm": "Gradient norm (before clipping)",
  "optimizer/gradient_norm_after_clip": "Gradient norm (after clipping)",
  "optimizer/gradient_clip_threshold": "Gradient clipping threshold",
  "optimizer/gradient_clipped": "Gradient clipped (0 / 1)",
  grad_norm: "Gradient norm",
  "train/grad_norm": "Gradient norm",
  gradient_norm: "Gradient norm",
  "checkpoint/tokens": "Checkpoint tokens",
  "checkpoint/step": "Checkpoint step",
};
const emptyHidden = new Set<string>();
const transformY = (value: number, scale: Scale) =>
  scale === "log" ? Math.log10(value) : value;
const inverseY = (value: number, scale: Scale) =>
  scale === "log" ? 10 ** value : value;

export function RunChart({
  series,
  range = 0,
  hidden = emptyHidden,
}: {
  series: Series[];
  range?: number;
  hidden?: Set<string>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const allPoints = series.flatMap((s) => s.points);
  const [axis, setAxis] = useState<Axis>(
    allPoints.length && allPoints.every((p) => Number.isFinite(p.tokens))
      ? "tokens"
      : "step",
  );
  const [scale, setScale] = useState<Scale>(
    series.length === 1 && /perplexity/i.test(series[0].name)
      ? "log"
      : "linear",
  );
  const [smooth, setSmooth] = useState(0.9);
  const [mode, setMode] = useState("zoom");
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [muted, setMuted] = useState(new Set<string>());
  const [viewport, setViewport] = useState<Viewport>({});
  const [size, setSize] = useState({ width: 500, height: 285 });
  const [inView, setInView] = useState(false);
  const [frame, setFrame] = useState<ImageFrame>();
  const [hover, setHover] = useState<Hover[]>([]);
  const [drag, setDrag] = useState<Drag>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((e) => e.isIntersecting)),
      { rootMargin: "300px" },
    );
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      if (box.width && box.height)
        setSize({
          width: Math.max(240, Math.min(1600, Math.round(box.width))),
          height: Math.max(200, Math.min(900, Math.round(box.height))),
        });
    });
    observer.observe(canvas.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setViewport({});
    setHover([]);
  }, [axis, scale, range]);
  const traces = useMemo(() => {
    const stamps = series
      .flatMap((s) =>
        s.points.map((p) => (p.timestamp ? Date.parse(p.timestamp) : NaN)),
      )
      .filter(Number.isFinite);
    const origin = stamps.length ? Math.min(...stamps) : 0;
    const output: Trace[] = [];
    series.forEach((s, index) => {
      if (hidden.has(s.id || s.name) || muted.has(s.id || s.name)) return;
      const points = s.points.filter(
        (p) => Number.isFinite(p.value) && (scale !== "log" || p.value > 0),
      );
      const x = points.map((p) =>
        axis === "tokens"
          ? (p.tokens ?? p.step)
          : axis === "elapsed" && p.timestamp
            ? (Date.parse(p.timestamp) - origin) / 1000
            : p.step,
      );
      const color = s.color || palette[index % palette.length];
      // Normalize the accumulated weights to avoid an initial-value bias.
      // Sparse series remain raw points, so three validation checks do not
      // acquire a misleading smooth trend.
      const smoothing = smooth > 0 && points.length >= 5;
      let total = 0,
        weight = 0;
      const y = points.map((p) => {
        total = smooth * total + (1 - smooth) * p.value;
        weight = smooth * weight + (1 - smooth);
        return smoothing ? total / weight : p.value;
      });
      if (smoothing)
        output.push({
          name: labels[s.name] || s.name,
          color,
          x,
          y: points.map((p) => p.value),
          points,
          alpha: 0.3,
          kind: "points",
          raw: true,
        });
      output.push({
        name: labels[s.name] || s.name,
        color,
        x,
        y,
        points,
        alpha: 1,
        kind: smoothing ? "trend" : "points",
      });
    });
    return output;
  }, [series, hidden, muted, axis, scale, smooth]);
  const payload = JSON.stringify({
    series: traces.map(({ name, color, x, y, alpha, kind }) => ({
      name,
      color,
      x,
      y,
      alpha,
      kind,
    })),
    ...size,
    axis,
    scale,
    skip: range,
    ...viewport,
  });
  useEffect(() => {
    if (!inView) return;
    const abort = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        let result: ImageFrame | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            result = await request<ImageFrame>("/api/charts/render", {
              method: "POST",
              body: payload,
              signal: abort.signal,
            });
            break;
          } catch (e) {
            if (
              (e as { statusCode?: number }).statusCode !== 429 ||
              attempt === 5
            )
              throw e;
            await new Promise((resolve) =>
              setTimeout(resolve, 400 * (attempt + 1)),
            );
            abort.signal.throwIfAborted();
          }
        }
        if (!cancelled && result) setFrame({ ...result, traces, scale });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
    };
    // The serialized payload stays equal between polls with unchanged measurements.
  }, [payload, inView]);
  function position(event: PointerEvent<HTMLDivElement>): [number, number] {
    const box = canvas.current!.getBoundingClientRect();
    return [
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    ];
  }
  function within(point: [number, number], image: ImageFrame) {
    const [x, y, w, h] = image.axes;
    return (
      point[0] >= x && point[0] <= x + w && point[1] >= y && point[1] <= y + h
    );
  }
  function coordinates(
    point: [number, number],
    image: ImageFrame,
  ): [number, number] {
    const [x, y, w, h] = image.axes;
    const fractionX = Math.max(0, Math.min(1, (point[0] - x) / w));
    const fractionY = Math.max(0, Math.min(1, (point[1] - y) / h));
    const low = transformY(image.ylim[0], image.scale),
      high = transformY(image.ylim[1], image.scale);
    return [
      image.xlim[0] + fractionX * (image.xlim[1] - image.xlim[0]),
      inverseY(high - fractionY * (high - low), image.scale),
    ];
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const point = position(event);
    if (drag) {
      setDrag({ ...drag, end: point });
      return;
    }
    if (!frame || !within(point, frame)) {
      setHover([]);
      return;
    }
    const [left, top, width, height] = frame.axes;
    const low = transformY(frame.ylim[0], frame.scale),
      high = transformY(frame.ylim[1], frame.scale);
    const matches: Hover[] = [];
    for (const t of frame.traces.filter((t) => !t.raw)) {
      let best = -1,
        distance = 40 ** 2;
      t.x.forEach((x, i) => {
        const px =
          left +
          ((x - frame.xlim[0]) / (frame.xlim[1] - frame.xlim[0])) * width;
        const py =
          top +
          ((high - transformY(t.y[i], frame.scale)) / (high - low)) * height;
        const rawPy =
          top +
          ((high - transformY(t.points[i].value, frame.scale)) / (high - low)) *
            height;
        const d =
          ((px - point[0]) * size.width) ** 2 +
          Math.min(
            ((py - point[1]) * size.height) ** 2,
            ((rawPy - point[1]) * size.height) ** 2,
          );
        if (d < distance) {
          best = i;
          distance = d;
        }
      });
      if (best >= 0)
        matches.push({
          name: t.name,
          color: t.color,
          value: t.y[best],
          point: t.points[best],
          smoothed: t.kind === "trend",
        });
    }
    setHover(matches);
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const finish = position(event),
      image = drag.frame;
    const a = coordinates(drag.start, image),
      b = coordinates(finish, image);
    const horizontal = Math.abs(finish[0] - drag.start[0]) * size.width;
    const vertical = Math.abs(finish[1] - drag.start[1]) * size.height;
    if (
      drag.mode === "pan"
        ? Math.max(horizontal, vertical) > 4
        : horizontal > 4 && vertical > 4
    ) {
      if (drag.mode === "zoom")
        setViewport({
          xlim: [Math.min(a[0], b[0]), Math.max(a[0], b[0])],
          ylim: [Math.min(a[1], b[1]), Math.max(a[1], b[1])],
        });
      else {
        const dx = a[0] - b[0],
          dy = transformY(a[1], image.scale) - transformY(b[1], image.scale);
        setViewport({
          xlim: [image.xlim[0] + dx, image.xlim[1] + dx],
          ylim: image.ylim.map((v) =>
            inverseY(transformY(v, image.scale) + dy, image.scale),
          ) as Bounds,
        });
      }
    }
    setDrag(undefined);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return (
    <div
      ref={root}
      className={"interactive-chart" + (expanded ? " plot-expanded" : "")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSettings(false);
          setExpanded(false);
          setDrag(undefined);
        }
      }}
    >
      <div className="plot-toolbar">
        <span className="plot-count">
          {Math.max(0, ...series.map((s) => s.points.length)).toLocaleString()}{" "}
          measurements
          {traces.some((t) => t.kind === "trend") ? ` · EMA ${smooth}` : ""}
        </span>
        <label
          className="plot-ema-control"
          title="EMA averages recent measurements; raw points stay visible. Fewer than five measurements stay unsmoothed."
        >
          EMA
          <select
            aria-label="EMA smoothing"
            value={smooth}
            onChange={(e) => setSmooth(Number(e.target.value))}
          >
            <option value="0">Off</option>
            <option value="0.5">0.5</option>
            <option value="0.8">0.8</option>
            <option value="0.9">0.9</option>
            <option value="0.95">0.95</option>
            <option value="0.99">0.99</option>
            {![0, 0.5, 0.8, 0.9, 0.95, 0.99].includes(smooth) && (
              <option value={smooth}>{smooth}</option>
            )}
          </select>
        </label>
        <div className="plot-actions">
          <button
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => {
              setViewport({});
              setHover([]);
            }}
          >
            ↺
          </button>
          <button
            aria-label="Download chart as PNG"
            title="Download PNG"
            disabled={!frame}
            onClick={() => {
              if (!frame) return;
              const link = document.createElement("a");
              link.href = frame.image;
              link.download = "fabryka-metrics.png";
              link.click();
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
          X axis{" "}
          <select
            aria-label="X axis"
            value={axis}
            onChange={(e) => setAxis(e.target.value as Axis)}
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
          Y axis{" "}
          <select
            aria-label="Y axis scale"
            value={scale}
            onChange={(e) => setScale(e.target.value as Scale)}
          >
            <option value="linear">Linear</option>
            <option value="log">Logarithmic</option>
          </select>
        </label>
        <label>
          Interaction{" "}
          <select
            aria-label="Chart interaction"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
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
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div
        ref={canvas}
        className="plot-canvas matplotlib-canvas"
        role="img"
        aria-label="Training metrics rendered with Matplotlib"
        style={{ cursor: mode === "pan" ? "grab" : "crosshair" }}
        onPointerMove={move}
        onPointerLeave={() => {
          if (!drag) setHover([]);
        }}
        onPointerDown={(e) => {
          if (e.button === 0 && frame && within(position(e), frame)) {
            setDrag({ start: position(e), end: position(e), mode, frame });
            setHover([]);
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerUp={end}
        onPointerCancel={() => setDrag(undefined)}
        onDoubleClick={() => setViewport({})}
      >
        {frame && (
          <img
            src={frame.image}
            alt="Recorded metric measurements"
            draggable={false}
          />
        )}
        {!frame && (
          <span className="matplotlib-status">
            {loading ? "Rendering chart…" : "Waiting for chart…"}
          </span>
        )}
        {drag?.mode === "zoom" && (
          <div
            className="matplotlib-selection"
            style={{
              left: `${Math.min(drag.start[0], drag.end[0]) * 100}%`,
              top: `${Math.min(drag.start[1], drag.end[1]) * 100}%`,
              width: `${Math.abs(drag.start[0] - drag.end[0]) * 100}%`,
              height: `${Math.abs(drag.start[1] - drag.end[1]) * 100}%`,
            }}
          />
        )}
      </div>
      <div className="plot-tooltip" hidden={!hover.length}>
        <div className="plot-tooltip-head">
          STEP <b>{fmt(hover[0]?.point.step, 4)}</b>
          {frame?.traces.some((t) => t.kind === "trend") && (
            <span>EMA · raw</span>
          )}
        </div>
        {hover.map((p, i) => (
          <div key={i} className="plot-tooltip-row">
            <i style={{ background: p.color }} />
            <span>{p.name}</span>
            <b>{fmt(p.value, 4)}</b>
            {p.smoothed && <small>{fmt(p.point.value, 4)}</small>}
          </div>
        ))}
      </div>
      <div className="plot-legend">
        {series.map((s, i) => {
          const key = s.id || s.name,
            off = hidden.has(key) || muted.has(key);
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
