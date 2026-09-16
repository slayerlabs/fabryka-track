import { Fragment, useState } from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { request } from "../provider";
import { MetricHelp } from "./BenchmarkHelp";
import guide from "./BenchmarkGuide.html?raw";
interface TaskResult {
  accuracy?: number;
  bpb?: number;
  nll?: number;
  samples?: number;
  mean_margin_nats?: number;
  mean_correct_probability?: number;
  error?: string;
}
interface Evaluation {
  id: string;
  run_id: string;
  run_name: string;
  mode: string;
  status: string;
  queue_position?: number;
  current_task?: string;
  tasks: string[];
  results: Record<string, TaskResult>;
  tiny_score?: number;
  fast_score?: number;
  protocol?: string;
  created_at: string;
  error?: string;
}
interface Catalog {
  available: boolean;
  core: string[];
  tasks: { id: string; name: string }[];
}
interface SavedRun {
  id: string;
  name: string;
  state: string;
  metadata: { engine?: string };
  config: { model_size?: string };
}
interface EvaluationPage {
  items: Evaluation[];
  total: number;
}
const percent = (value?: number) =>
  Number.isFinite(value) ? (value! * 100).toFixed(1) + "%" : "—";
const metric = (value?: number) =>
  Number.isFinite(value) ? value!.toFixed(4) : "—";
function EvaluationDetails({
  evaluation: e,
  catalog,
}: {
  evaluation: Evaluation;
  catalog: Catalog;
}) {
  return (
    <>
      {e.protocol === "fast-en-v1" ? (
        <section className="panel" style={{ padding: 16, margin: "12px 0" }}>
          <b>
            {e.mode === "smoke" ? "Smoke " : ""}FastScore EN:{" "}
            {percent(e.fast_score)}
          </b>
          <small> · Experimental internal score · {e.protocol}</small>
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Measurements</th>
                <th>Items / bytes</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["fast_lm", "Held-out LM · 40%"],
                ["fast_blimp", "BLiMP-fast · 35%"],
                ["fast_supplement", "BLiMP Supplement · 10%"],
                ["fast_ewok", "EWoK-fast · 5%"],
                ["fast_arc", "ARC-Easy · 10%"],
              ].map(([key, name]) => {
                const value = e.results[key] || {};
                return (
                  <tr key={key}>
                    <td>{name}</td>
                    <td>
                      {key === "fast_ewok" && !value.samples ? (
                        "HF access required"
                      ) : value.error ? (
                        value.error
                      ) : key === "fast_lm" ? (
                        <>
                          BPB {metric(value.bpb)} · NLL {metric(value.nll)}
                        </>
                      ) : (
                        <>
                          Accuracy {percent(value.accuracy)} · margin{" "}
                          {metric(value.mean_margin_nats)} nats
                          {value.mean_correct_probability != null && (
                            <>
                              {" "}
                              · P(correct){" "}
                              {percent(value.mean_correct_probability)}
                            </>
                          )}
                        </>
                      )}
                    </td>
                    <td>{value.samples ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <small>
            Fixed English diagnostics. Not comparable with TinyScore. Smoke
            checks execution only. External held-out split; training overlap has
            not been audited.
          </small>
        </section>
      ) : (
        <>
          <p>
            {e.protocol} · {Object.keys(e.results).length}/
            {e.tasks?.length || 0} tasks
          </p>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Accuracy</th>
                <th>Samples</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(e.results).map(([key, value]) => (
                <tr key={key}>
                  <td>
                    {catalog.tasks.find((task) => task.id === key)?.name || key}
                  </td>
                  <td>{value.error || percent(value.accuracy)}</td>
                  <td>{value.samples ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {e.error && <p role="alert">{e.error}</p>}
    </>
  );
}
export function BenchmarksPage() {
  const [offset, setOffset] = useState(0),
    [order, setOrder] = useState<"asc" | "desc" | null>(null),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [runId, setRunId] = useState(""),
    [suite, setSuite] = useState("fast"),
    [mode, setMode] = useState("smoke"),
    [message, setMessage] = useState("");
  const catalogQuery = useCustom<Catalog>({
    url: "/api/benchmarks/catalog",
    method: "get",
  });
  const runsQuery = useCustom<SavedRun[]>({
    url: "/api/projects",
    method: "get",
    queryOptions: {
      queryKey: ["benchmark-saved-runs"],
      queryFn: async ({ signal }) => {
        const projects = await request<{ name: string }[]>("/api/projects", {
          signal,
        });
        const runs = (
          await Promise.all(
            projects.map((project) =>
              request<SavedRun[]>(
                "/api/projects/" + encodeURIComponent(project.name) + "/runs",
                { signal },
              ),
            ),
          )
        )
          .flat()
          .filter(
            (run) =>
              run.state === "finished" &&
              run.metadata.engine === "tiny-transformer",
          );
        return { data: runs };
      },
    },
  });
  const queue = useCustom<{
    running: number;
    waiting: number;
    items: Evaluation[];
  }>({
    url: "/api/benchmarks/queue",
    method: "get",
    queryOptions: { refetchInterval: 5000 },
  });
  const history = useCustom<EvaluationPage>({
    url: "/api/benchmarks/evaluations?limit=20&offset=" + offset,
    method: "get",
    queryOptions: {
      queryKey: ["benchmark-history", offset, order],
      refetchInterval: 5000,
      queryFn: async ({ signal }) => {
        if (!order)
          return {
            data: await request<EvaluationPage>(
              "/api/benchmarks/evaluations?limit=20&offset=" + offset,
              { signal },
            ),
          };
        const all = await request<EvaluationPage>(
          "/api/benchmarks/evaluations?limit=100&offset=0",
          { signal },
        );
        for (let start = 100; start < all.total; start += 100) {
          const page = await request<EvaluationPage>(
            "/api/benchmarks/evaluations?limit=100&offset=" + start,
            { signal },
          );
          all.items.push(...page.items);
        }
        all.items.sort((a, b) => {
          const av = Number.isFinite(a.tiny_score),
            bv = Number.isFinite(b.tiny_score);
          if (av !== bv) return av ? -1 : 1;
          return av
            ? (order === "desc" ? -1 : 1) * (a.tiny_score! - b.tiny_score!)
            : 0;
        });
        return {
          data: { ...all, items: all.items.slice(offset, offset + 20) },
        };
      },
    },
  });
  const mutation = useCustomMutation<Evaluation>();
  const catalog = catalogQuery.query.data?.data,
    runs = runsQuery.query.data?.data || [],
    h = history.query.data?.data,
    q = queue.query.data?.data;
  const failure =
    catalogQuery.query.error ||
    runsQuery.query.error ||
    history.query.error ||
    queue.query.error;
  async function refresh() {
    await Promise.all([queue.query.refetch(), history.query.refetch()]);
  }
  return (
    <>
      <div className="compare-heading">
        <div>
          <div className="eyebrow">Evaluation studio</div>
          <h1>Benchmarks</h1>
          <p className="muted">
            Run missing tasks. Keep completed results. Compare measured results.{" "}
            <a href="/benchmark-results">
              Browse published checkpoint results →
            </a>
          </p>
        </div>
        <a className="secondary" href="/runs">
          My runs →
        </a>
      </div>
      <MetricHelp />
      <div dangerouslySetInnerHTML={{ __html: guide }} />
      {failure && (
        <p role="alert">
          {failure.message}{" "}
          <button
            className="secondary"
            onClick={() => {
              void catalogQuery.query.refetch();
              void runsQuery.query.refetch();
              void refresh();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="panel" style={{ padding: 16 }}>
        <form
          id="global-benchmark-form"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await mutation.mutateAsync({
                url: "/api/runs/" + (runId || runs[0]?.id) + "/benchmarks",
                method: "post",
                values: { suite, mode },
              });
              setMessage("Evaluation added to the queue.");
              setOffset(0);
              await refresh();
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Evaluation could not be added.",
              );
            }
          }}
        >
          <div className="fields">
            <label className="field">
              <span>Saved model</span>
              <select
                name="run_id"
                required
                value={runId || runs[0]?.id || ""}
                onChange={(e) => setRunId(e.target.value)}
              >
                {runs.length ? (
                  runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.name} · {run.config.model_size || "model"}
                    </option>
                  ))
                ) : (
                  <option value="">No finished models yet</option>
                )}
              </select>
            </label>
            <label className="field">
              <span>Suite</span>
              <select
                name="suite"
                value={suite}
                onChange={(e) => setSuite(e.target.value)}
              >
                {[
                  ["fast", "Fast ladder EN · 4 ready / EWoK pending"],
                  [
                    "fast_pl",
                    "Fast ladder PL · Polish BPB + agreement + induction",
                  ],
                  ["tinylm", "TinyLM · 6 tasks"],
                  ["piqa", "PIQA only · English physical commonsense"],
                  ["core", "Core · 5 tasks"],
                  ["extended", "Extended · 8 tasks"],
                ].map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Evaluation size</span>
              <select
                name="mode"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="smoke">Smoke · 10 examples per subtask</option>
                <option value="full">
                  Full suite · fixed sample for Fast ladder
                </option>
              </select>
            </label>
          </div>
          <button
            className="primary"
            disabled={
              !runs.length || !catalog?.available || mutation.mutation.isPending
            }
          >
            Run missing benchmarks
          </button>
          <small className="muted" style={{ marginLeft: 12 }}>
            FIFO · up to 20 waiting · one active evaluation per worker
          </small>
        </form>
      </section>
      <section id="benchmark-dashboard-queue" style={{ margin: "22px 0" }}>
        <div className="row">
          <h2 style={{ fontSize: 23 }}>Queue</h2>
          {q && (
            <small>
              {q.running} running · {q.waiting} waiting
            </small>
          )}
        </div>
        {!q ? (
          <p>Loading queue…</p>
        ) : q.items.length ? (
          <div
            className="panel benchmark-queue"
            style={{ padding: "6px 14px" }}
          >
            {q.items.map((e) => (
              <div className="legend" key={e.id}>
                <div>
                  <a href={"/run/" + e.run_id}>{e.run_name}</a>
                  <small style={{ display: "block" }}>
                    {e.mode} · {e.tasks.length} tasks
                  </small>
                </div>
                <span>
                  {e.status === "queued"
                    ? "Queue #" + e.queue_position
                    : e.current_task || "Starting worker"}{" "}
                  · {Object.keys(e.results).length}/{e.tasks.length}{" "}
                  <button
                    className="secondary"
                    disabled={mutation.mutation.isPending}
                    onClick={async () => {
                      try {
                        await mutation.mutateAsync({
                          url:
                            "/api/runs/" +
                            e.run_id +
                            "/benchmarks/" +
                            e.id +
                            "/cancel",
                          method: "post",
                          values: {},
                        });
                        await refresh();
                      } catch (error) {
                        setMessage(
                          error instanceof Error
                            ? error.message
                            : "Evaluation could not be cancelled.",
                        );
                      }
                    }}
                  >
                    Cancel
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel" style={{ padding: 20 }}>
            <small>No pending evaluations for your models.</small>
          </div>
        )}
      </section>
      <section id="benchmark-history">
        <h2 style={{ fontSize: 23 }}>Evaluation history</h2>
        {catalog && h ? (
          <>
            <div className="comparison-table">
              <table className="benchmark-history-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th
                      aria-sort={
                        order === "desc"
                          ? "descending"
                          : order === "asc"
                            ? "ascending"
                            : "none"
                      }
                    >
                      <button
                        className="secondary"
                        title="Sort all evaluations by TinyScore"
                        onClick={() => {
                          setOrder(order === "desc" ? "asc" : "desc");
                          setOffset(0);
                        }}
                      >
                        TinyScore{" "}
                        {order === "desc" ? "↓" : order === "asc" ? "↑" : "↕"}
                      </button>
                    </th>
                    {catalog.core.map((key) => (
                      <th className="metric-column" key={key}>
                        {catalog.tasks.find((task) => task.id === key)?.name ||
                          key}
                      </th>
                    ))}
                    <th>Started</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {h.items.length ? (
                    h.items.map((e) => (
                      <Fragment key={e.id}>
                        <tr>
                          <td>
                            <a
                              className="benchmark-model-link"
                              href={"/run/" + e.run_id}
                              title={e.run_name}
                            >
                              {e.run_name}
                            </a>
                          </td>
                          <td>
                            {e.status}
                            {e.queue_position ? " #" + e.queue_position : ""}
                          </td>
                          <td>{e.mode}</td>
                          <td>
                            <b>{percent(e.tiny_score)}</b>
                          </td>
                          {catalog.core.map((key) => (
                            <td key={key}>
                              {percent(e.results[key]?.accuracy)}
                            </td>
                          ))}
                          <td title={new Date(e.created_at).toLocaleString()}>
                            {new Date(e.created_at).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td>
                            <button
                              className="secondary eval-details-toggle"
                              aria-expanded={expanded.has(e.id)}
                              aria-controls={"eval-details-" + e.id}
                              onClick={() =>
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(e.id)) next.delete(e.id);
                                  else next.add(e.id);
                                  return next;
                                })
                              }
                            >
                              {expanded.has(e.id) ? "Hide" : "Details"}
                            </button>
                          </td>
                        </tr>
                        <tr
                          className="benchmark-details"
                          id={"eval-details-" + e.id}
                          hidden={!expanded.has(e.id)}
                        >
                          <td colSpan={catalog.core.length + 6}>
                            <EvaluationDetails
                              evaluation={e}
                              catalog={catalog}
                            />
                          </td>
                        </tr>
                      </Fragment>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={catalog.core.length + 6}>
                        No measurements yet. Add a saved model to the queue
                        above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 11 }}>
              Task columns show accuracy. TinyScore averages chance-normalized
              scores across the five core tasks. Smoke results use small
              samples; compare full evaluations for quality.
            </p>
          </>
        ) : (
          <p>Loading evaluations…</p>
        )}
      </section>
      <div className="actions">
        <button
          className="secondary"
          disabled={offset === 0 || history.query.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          ← Previous
        </button>
        <small>
          {h?.total
            ? `${offset + 1}–${Math.min(offset + 20, h.total)} of ${h.total}`
            : "0 evaluations"}
        </small>
        <button
          className="secondary"
          disabled={!h || offset + 20 >= h.total || history.query.isFetching}
          onClick={() => setOffset(offset + 20)}
        >
          Next →
        </button>
      </div>
    </>
  );
}
