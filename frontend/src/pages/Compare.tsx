import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { RunChart, palette } from "./RunChart";
import {
  activeRun,
  fmt,
  latest,
  RangeControls,
  RunError,
  useRunQuery,
  type Run,
} from "./RunData";

export function ComparePage() {
  const { ids = "" } = useParams();
  const [params] = useSearchParams();
  return (
    <Comparison
      key={ids}
      ids={ids.split(",").filter(Boolean)}
      metric={params.get("metric")}
    />
  );
}
function Comparison({ ids, metric }: { ids: string[]; metric: string | null }) {
  const query = useRunQuery<Run[]>(
    "/api/compare?" +
      ids.map((id) => "ids=" + encodeURIComponent(id)).join("&"),
    (data) => (!data || data.some(activeRun) ? 5000 : false),
  );
  const [tab, setTab] = useState("charts");
  const [runFilter, setRunFilter] = useState("");
  const [metricFilter, setMetricFilter] = useState("");
  const [hidden, setHidden] = useState(new Set<string>());
  const [range, setRange] = useState(0);
  const [layout, setLayout] = useState("grid");
  const runs = query.data || [];
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))].filter(
    (key) => key !== "progress" && (!metric || key === metric),
  );
  const shownKeys = keys.filter((key) =>
    key.toLowerCase().includes(metricFilter.toLowerCase()),
  );
  const configKeys = ["model", "batch_size", "learning_rate", "seed"];
  return (
    <div className="compare-view">
      <div className="compare-heading">
        <div>
          <Link to="/runs" className="muted">
            ← All runs
          </Link>
          <h1>Compare experiments</h1>
          <small className="muted">
            {runs.length} runs · {keys.length} metrics · hover across charts to
            inspect the same step
          </small>
        </div>
        <Link to="/runs" className="secondary">
          Change selection
        </Link>
      </div>
      <RunError error={query.error} retry={() => void query.refetch()} />
      {query.isLoading && <p role="status">Loading comparison…</p>}
      <div className="compare-tabs" role="tablist">
        {[
          ["charts", "Charts"],
          ["table", "Side by side"],
        ].map(([key, title]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {title}
          </button>
        ))}
      </div>
      <div className="compare-workspace">
        <aside className="compare-sidebar">
          <header>
            <b>
              Visible runs{" "}
              <span>
                {runs.filter((r) => !hidden.has(r.id)).length} / {runs.length}
              </span>
            </b>
            <input
              type="search"
              placeholder="Find a run…"
              aria-label="Find a compared run"
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
            />
          </header>
          {runs.map((r, i) => (
            <label
              key={r.id}
              className="compare-run"
              hidden={!r.name.toLowerCase().includes(runFilter.toLowerCase())}
            >
              <input
                type="checkbox"
                checked={!hidden.has(r.id)}
                aria-label={"Show " + r.name}
                onChange={() =>
                  setHidden((previous) => {
                    const next = new Set(previous);
                    next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                    return next;
                  })
                }
              />
              <span
                className="plot-swatch"
                style={{ background: palette[i % palette.length] }}
              />
              <span>
                <Link to={"/run/" + r.id} title={r.name}>
                  {r.name}
                </Link>
                <small>
                  {r.config.model_size || r.project} · {r.state}
                </small>
              </span>
            </label>
          ))}
        </aside>
        <section className="compare-main">
          <div className="metric-explorer">
            <small>{shownKeys.length} metrics</small>
            <div className="explorer-controls">
              <input
                type="search"
                placeholder="Find a metric…"
                aria-label="Filter comparison metrics"
                value={metricFilter}
                onChange={(e) => setMetricFilter(e.target.value)}
              />
              <RangeControls
                range={range}
                setRange={setRange}
                layout={layout}
                setLayout={setLayout}
              />
            </div>
          </div>
          <div
            className="charts comparison-board"
            hidden={tab !== "charts"}
            style={{
              gridTemplateColumns: layout === "column" ? "1fr" : undefined,
            }}
          >
            {keys.map((key) => (
              <article
                key={key}
                className="chart"
                hidden={!shownKeys.includes(key)}
              >
                <h3>{key}</h3>
                <RunChart
                  range={range}
                  hidden={hidden}
                  series={runs.map((r, i) => ({
                    id: r.id,
                    name: r.name,
                    color: palette[i % palette.length],
                    points: r.metrics[key] || [],
                  }))}
                />
              </article>
            ))}
          </div>
          <div className="comparison-table" hidden={tab !== "table"}>
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  {keys.map((k) => (
                    <th key={k} className="metric-column">
                      {k}
                    </th>
                  ))}
                  {configKeys.map((k) => (
                    <th key={k} className="config-column">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={"/run/" + r.id}>
                        <span
                          className="dot"
                          style={{ background: palette[i % palette.length] }}
                        />
                        {r.name}
                      </Link>
                    </td>
                    <td>{r.state}</td>
                    {keys.map((k) => (
                      <td key={k}>{fmt(latest(r, k), 4)}</td>
                    ))}
                    {configKeys.map((k) => (
                      <td key={k}>{String(r.config[k] ?? "—")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!query.isLoading && !keys.length && (
            <p className="muted">No matching metrics have been recorded.</p>
          )}
        </section>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
        Validation scores depend on the dataset split. Compare quality only
        across matching evaluation protocols.
      </p>
    </div>
  );
}
