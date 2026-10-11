import { useMemo } from "react";
import { piiBars, waterfallBars } from "./charts";
import { COPY } from "./copy";
import { humanize } from "./display";
import { PlotlyChart, type Palette, type PlotSpec } from "./PlotlyChart";
import type { CheckRow, Summary } from "./results";

const count = (value: number) => value.toLocaleString("en-US");

function bars(
  rows: { label: string; value: number; base?: number; color: string }[],
  { ink, line }: Palette,
  stacked: boolean,
): PlotSpec {
  const labels = rows.map((row) => `${row.label} · ${count(row.value)}`);
  const visible = {
    type: "bar",
    orientation: "h",
    y: labels,
    x: rows.map((row) => row.value),
    marker: { color: rows.map((row) => row.color) },
    hovertemplate: "%{y}<extra></extra>",
  };
  const base = { type: "bar", orientation: "h", y: labels, x: rows.map((row) => row.base ?? 0), marker: { color: "transparent" }, hoverinfo: "skip" };
  return {
    data: stacked ? [base, visible] : [visible],
    layout: {
      barmode: stacked ? "stack" : "group",
      showlegend: false,
      height: 70 + 34 * rows.length,
      margin: { l: 250, r: 20, t: 10, b: 40 },
      font: { color: ink },
      xaxis: { title: { text: COPY.charts.axis }, tickformat: ",d", gridcolor: line, rangemode: "tozero" },
      yaxis: { autorange: "reversed", automargin: true },
    },
  };
}

function CheckGrid({ checks }: { checks: CheckRow[] }) {
  return (
    <div className="chart">
      <h3>{COPY.charts.checks}</h3>
      <ul className="check-grid">
        {checks.map((check) => (
          <li key={check.name} className={`check-cell ${check.status === "passed" || check.status === "failed" ? check.status : "other"}`}>
            <strong>{check.label}</strong>
            <span>{humanize(check.status)}</span>
            <small>
              {check.binding ? "Required" : "Advisory"}
              {check.count !== null && ` · ${count(check.count)}`}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResultCharts({ summary }: { summary: Summary }) {
  const funnel = useMemo(() => waterfallBars(summary.funnel), [summary.funnel]);
  const pii = useMemo(() => piiBars(summary.pii), [summary.pii]);
  const funnelSpec = useMemo(
    () => (palette: Palette) =>
      bars(funnel.map((bar) => ({ ...bar, color: bar.kind === "total" ? palette.accent : palette.amber })), palette, true),
    [funnel],
  );
  const piiSpec = useMemo(() => (palette: Palette) => bars(pii.map((row) => ({ ...row, color: palette.green })), palette, false), [pii]);
  return (
    <div className="result-charts">
      {funnel.length > 0 && <PlotlyChart title={COPY.charts.funnel} build={funnelSpec} />}
      {summary.checks && summary.checks.length > 0 && <CheckGrid checks={summary.checks} />}
      {pii.length > 0 && <PlotlyChart title={COPY.charts.pii} build={piiSpec} />}
    </div>
  );
}
