import { useEffect, useRef, useState } from "react";

interface ChartPlotly {
  newPlot: (element: HTMLElement, data: unknown[], layout: object, config: object) => Promise<unknown>;
  purge: (element: HTMLElement) => void;
  Plots: { resize: (element: HTMLElement) => void };
}

export interface BarEntry {
  label: string;
  value: number;
}

export function CountBars({
  title,
  entries,
  ariaLabel,
}: {
  title: string;
  entries: BarEntry[];
  ariaLabel: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = container.current;
    // Plotly is loaded by the application shell's pinned script.
    const chartWindow = window as unknown as { Plotly?: ChartPlotly };
    const plotly = chartWindow.Plotly;
    if (!element || !plotly) {
      setError("The chart library could not be loaded. Reload this page to try again.");
      return;
    }
    let disposed = false;
    void plotly
      .newPlot(
        element,
        [
          {
            x: entries.map((entry) => entry.label),
            y: entries.map((entry) => entry.value),
            type: "bar",
          },
        ],
        {
          autosize: true,
          height: 240,
          margin: { l: 55, r: 15, t: 12, b: 90 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          xaxis: { tickangle: -25 },
          yaxis: { title: { text: "Count" }, separatethousands: true },
        },
        { responsive: true, displaylogo: false },
      )
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
  }, [entries, title]);
  if (entries.length === 0) return null;
  return (
    <div className="chart">
      <h3>{title}</h3>
      {error && <p role="alert">{error}</p>}
      <div ref={container} aria-label={ariaLabel} />
    </div>
  );
}
