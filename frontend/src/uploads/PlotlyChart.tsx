import { useEffect, useRef, useState } from "react";
import { COPY } from "./copy";

interface PlotlyApi {
  newPlot: (element: HTMLElement, data: unknown[], layout: object, config: object) => Promise<unknown>;
  purge: (element: HTMLElement) => void;
  Plots: { resize: (element: HTMLElement) => void };
}

export interface Palette {
  accent: string;
  amber: string;
  green: string;
  ink: string;
  line: string;
}

export interface PlotSpec {
  data: unknown[];
  layout: object;
}

function palette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return { accent: token("--accent"), amber: token("--amber"), green: token("--green"), ink: token("--ink"), line: token("--line") };
}

export function PlotlyChart({ title, build }: { title: string; build: (palette: Palette) => PlotSpec }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = container.current;
    // Plotly is loaded by the application shell's pinned script.
    const plotly = (window as unknown as { Plotly?: PlotlyApi }).Plotly;
    if (!element || !plotly) {
      setError(COPY.charts.unavailable);
      return;
    }
    let disposed = false;
    const { data, layout } = build(palette());
    plotly
      .newPlot(element, data, { autosize: true, paper_bgcolor: "transparent", plot_bgcolor: "transparent", ...layout }, { responsive: true, displaylogo: false, displayModeBar: false })
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      });
    const observer = new ResizeObserver(() => {
      if (!disposed) plotly.Plots.resize(element);
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      plotly.purge(element);
    };
  }, [build]);
  return (
    <div className="chart">
      <h3>{title}</h3>
      {error ? <p className="error">{error}</p> : <div ref={container} role="img" aria-label={title} />}
    </div>
  );
}
