import { useEffect, useRef, useState } from "react";
import { useCustom } from "@refinedev/core";
import { useNavigate } from "react-router";
import { MetricHelp } from "./BenchmarkHelp";
interface LeaderModel {
  id: string;
  name: string;
  owner: string;
  rank: number;
  started_at: string;
  steps: number;
  val_loss?: number;
  perplexity?: number;
  train_loss?: number;
  throughput?: number;
  mix: { name: string; weight: number }[];
  auto_benchmark?: {
    score?: number;
    label: string;
    is_percent: boolean;
    state: string;
  };
}
interface LeaderSize {
  model_size: string;
  parameters?: number;
  models: LeaderModel[];
}
interface PlotlyApi {
  newPlot: (
    node: HTMLElement,
    traces: unknown[],
    layout: object,
    config: object,
  ) => Promise<unknown>;
  purge: (node: HTMLElement) => void;
}
const fmt = (value?: number, digits = 4) =>
  Number.isFinite(value)
    ? value!.toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "—";
const palette = [
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
function LeaderScatter({ rows }: { rows: LeaderModel[] }) {
  const element = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState("");
  const numeric = rows.filter(
    (row) => Number.isFinite(row.val_loss) && Number.isFinite(row.perplexity),
  );
  useEffect(() => {
    const node = element.current;
    if (!node || !numeric.length) return;
    // The page shell loads the Plotly browser bundle before React mounts.
    const chartWindow = window as unknown as { Plotly?: PlotlyApi };
    const plotly = chartWindow.Plotly;
    if (!plotly) {
      setFailure("Charts are unavailable. Numeric scores remain in the table.");
      return;
    }
    const families = [
      ...new Set(numeric.map((row) => row.name.replace(/-seed\d+$/i, ""))),
    ];
    const traces = families.map((family, index) => {
      const subset = numeric.filter(
        (row) => row.name.replace(/-seed\d+$/i, "") === family,
      );
      return {
        type: "scatter",
        mode: "markers",
        name: family,
        x: subset.map((row) => row.val_loss),
        y: subset.map((row) => row.perplexity),
        text: subset.map(
          (row) =>
            `${row.name.replace(/[<>]/g, "")} · ${row.owner.replace(/[<>]/g, "")}<br>${fmt(row.throughput, 0)} byte tokens/s · ${row.steps} steps`,
        ),
        hovertemplate:
          "%{text}<br>loss %{x:.4f} · perplexity %{y:.3f}<extra></extra>",
        marker: { size: 9, color: palette[index % palette.length] },
      };
    });
    let active = true;
    void plotly
      .newPlot(
        node,
        traces,
        {
          margin: { l: 52, r: 16, t: 8, b: 40 },
          height: 300,
          paper_bgcolor: "#f8f9f5",
          plot_bgcolor: "#f8f9f5",
          font: { family: "monospace", size: 11, color: "#647368" },
          xaxis: {
            title: { text: "Validation loss", font: { size: 10 } },
            gridcolor: "#edf0f2",
            zeroline: false,
          },
          yaxis: {
            title: { text: "Perplexity", font: { size: 10 } },
            gridcolor: "#edf0f2",
            zeroline: false,
          },
          legend: { orientation: "h", y: -0.28, font: { size: 10 } },
        },
        { responsive: true, displaylogo: false, displayModeBar: false },
      )
      .catch(() => {
        if (active)
          setFailure(
            "Chart could not be rendered. Numeric scores remain in the table.",
          );
      });
    return () => {
      active = false;
      plotly.purge(node);
    };
  }, [rows]);
  return (
    <>
      {!numeric.length ? (
        <p className="muted">No numeric scores yet.</p>
      ) : (
        <>
          <div ref={element} style={{ marginTop: 8 }} />
          {failure && <p role="status">{failure}</p>}
        </>
      )}
    </>
  );
}
export function LeaderboardPage() {
  const [sort, setSort] = useState("val_loss"),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const { query } = useCustom<{ sizes: LeaderSize[] }>({
    url:
      "/api/leaderboard?sort=" +
      sort +
      "&order=" +
      (["throughput", "started_at"].includes(sort) ? "desc" : "asc"),
    method: "get",
  });
  const sizes = query.data?.data.sizes || [],
    models = sizes.flatMap((size) => size.models);
  return (
    <>
      <div className="intro row">
        <div>
          <div className="eyebrow">Model leaderboard</div>
          <h1>Measured progress, side by side.</h1>
          <p className="muted">
            Published scores ranked by saved-checkpoint validation, grouped by
            model size — sizes aren't comparable on raw loss. Open a model to
            try a text continuation after signing in. Create an account to train
            and publish your own results.
          </p>
        </div>
        <a className="primary" href="/new">
          + New training run
        </a>
      </div>
      <section
        className="panel"
        style={{ padding: "14px 18px", margin: "0 0 18px" }}
      >
        <div className="row">
          <strong>Compare validation perplexity</strong>
          <button
            className="secondary"
            disabled={selected.size < 2}
            onClick={() =>
              navigate(
                "/compare/" +
                  [...selected].join(",") +
                  "?metric=val%2Fperplexity",
              )
            }
          >
            {selected.size < 2
              ? "Compare selected runs"
              : `Compare ${selected.size} runs`}
          </button>
        </div>
        <small className="muted">
          Select two or more finished runs to draw their validation perplexity
          on one synchronized chart.
        </small>
        <div
          className="row"
          style={{ marginTop: 10, gap: 14, flexWrap: "wrap" }}
        >
          {models.map((model) => (
            <label key={model.id}>
              <input
                type="checkbox"
                checked={selected.has(model.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(model.id);
                    else next.delete(model.id);
                    return next;
                  })
                }
              />{" "}
              {model.name}
            </label>
          ))}
        </div>
      </section>
      <div className="row" style={{ marginBottom: 20 }}>
        <label className="field" style={{ margin: 0, maxWidth: 240 }}>
          <span>Rank by</span>
          <select
            id="leader-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="val_loss">Lowest validation loss</option>
            <option value="perplexity">Lowest perplexity</option>
            <option value="throughput">Highest throughput</option>
            <option value="started_at">Newest run</option>
          </select>
        </label>
        <small className="muted">
          Lower loss and perplexity are better on the same evaluation data.
        </small>
      </div>
      <MetricHelp />
      {query.isError ? (
        <p role="alert">
          {query.error.message}{" "}
          <button className="secondary" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : query.isLoading ? (
        <p>Loading leaderboard…</p>
      ) : sizes.length ? (
        sizes.map((size) => (
          <section key={size.model_size}>
            <h2 style={{ fontSize: 20, margin: "28px 0 10px" }}>
              {(size.model_size || "unknown").toUpperCase()} ·{" "}
              {size.parameters
                ? size.parameters.toLocaleString() + " parameters"
                : "unknown size"}
            </h2>
            <div className="panel table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      "#",
                      "Model",
                      "Author",
                      "Validation loss",
                      "Perplexity",
                      "Last train loss",
                      "Tokens / sec",
                      "Auto benchmark",
                      "Recipe",
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {size.models.map((model) => (
                    <tr key={model.id}>
                      <td>
                        <strong>{model.rank}</strong>
                      </td>
                      <td>
                        <a href={"/run/" + model.id}>{model.name}</a>
                        <br />
                        <small>
                          {new Date(model.started_at).toLocaleString()} ·{" "}
                          {model.steps} steps
                        </small>
                      </td>
                      <td>{model.owner}</td>
                      <td>
                        <strong>{fmt(model.val_loss)}</strong>
                      </td>
                      <td>{fmt(model.perplexity)}</td>
                      <td>{fmt(model.train_loss)}</td>
                      <td>{fmt(model.throughput, 0)}</td>
                      <td>
                        {model.auto_benchmark ? (
                          model.auto_benchmark.score != null ? (
                            <>
                              {model.auto_benchmark.label} ·{" "}
                              {model.auto_benchmark.is_percent
                                ? fmt(model.auto_benchmark.score * 100, 1) + "%"
                                : fmt(model.auto_benchmark.score, 2)}
                            </>
                          ) : ["queued", "running"].includes(
                              model.auto_benchmark.state,
                            ) ? (
                            <span className="muted">running…</span>
                          ) : model.auto_benchmark.state === "failed" ? (
                            <span className="muted">failed</span>
                          ) : (
                            "—"
                          )
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {model.mix.map((item, index) => (
                          <div key={index}>
                            {item.name} {item.weight}%
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="panel"
              style={{ padding: "14px 18px", marginTop: 10 }}
            >
              <strong style={{ fontSize: 13 }}>
                Validation loss vs perplexity
              </strong>
              <LeaderScatter rows={size.models} />
            </div>
          </section>
        ))
      ) : (
        <div className="panel empty">
          <h2>No completed models yet.</h2>
          <p className="muted">
            Finish a training run and its measured validation metrics will
            appear here.
          </p>
          <a className="primary" href="/new">
            Start your first run →
          </a>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 18 }}>
        This is a smoke-test leaderboard. Scores are comparable when runs use
        the same model size, validation data and settings.
      </p>
    </>
  );
}
