import { useCustom } from "@refinedev/core";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { request } from "../provider";
import {
  activeRun,
  fmt,
  latest,
  RunError,
  useRunAction,
  useRunQuery,
  type Run,
} from "./RunData";
import { RunStatus } from "./RunStatus";

type QueueItem = {
  id: string;
  run_id: string;
  run_name: string;
  status: string;
  queue_position?: number;
  current_task?: string;
  mode: string;
  results: Record<string, unknown>;
  tasks: string[];
};
type Queue = { running: number; waiting: number; items: QueueItem[] };
let savedSelection = new Set<string>();
export function RunsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(savedSelection);
  const [message, setMessage] = useState("");
  const action = useRunAction();
  const { query } = useCustom<Run[]>({
    url: "/api/projects",
    method: "get",
    queryOptions: {
      queryKey: ["run-workspace", "all-runs"],
      retry: false,
      refetchInterval: (q) => (q.state.error ? 10000 : 5000),
      queryFn: async ({ signal }) => {
        const projects = await request<{ name: string }[]>("/api/projects", {
          signal,
        });
        const runs = (
          await Promise.all(
            projects.map((p) =>
              request<Run[]>(
                "/api/projects/" + encodeURIComponent(p.name) + "/runs",
                { signal },
              ),
            ),
          )
        ).flat();
        return {
          data: runs.sort(
            (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
          ),
        };
      },
    },
  });
  const queue = useRunQuery<Queue>("/api/benchmarks/queue", 5000);
  const runs = query.data?.data;
  useEffect(() => {
    if (runs)
      setSelected(
        (previous) =>
          new Set([...previous].filter((id) => runs.some((r) => r.id === id))),
      );
  }, [runs]);
  useEffect(() => {
    savedSelection = selected;
  }, [selected]);
  const visible =
    runs?.filter((r) => r.name.toLowerCase().includes(search.toLowerCase())) ||
    [];
  return (
    <>
      <div className="intro row">
        <div>
          <div className="eyebrow">Your experiments</div>
          <h1>Every mix tells a story.</h1>
          <p className="muted">
            {runs?.length ?? 0} saved runs. Select two or more to compare.
          </p>
        </div>
        <Link className="primary" to="/new">
          + New training run
        </Link>
      </div>
      <RunError error={query.error} retry={() => void query.refetch()} />
      <RunError error={action.error} />
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="row" style={{ marginBottom: 20 }}>
        <input
          aria-label="Search runs"
          placeholder="Search runs…"
          style={{ maxWidth: 300 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="secondary"
          disabled={selected.size < 2}
          onClick={() => navigate("/compare/" + [...selected].join(","))}
        >
          Compare ({selected.size})
        </button>
      </div>
      <section aria-label="Current training runs">
        {runs?.some(activeRun) && (
          <>
            <h2 style={{ fontSize: 24 }}>Current runs</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill,minmax(min(340px,100%),1fr))",
                gap: 10,
              }}
            >
              {runs.filter(activeRun).map((r) => (
                <article key={r.id} className="panel" style={{ padding: 12 }}>
                  <div className="row">
                    <Link to={"/run/" + r.id}>
                      <h3 style={{ fontSize: 14, margin: 0 }}>{r.name}</h3>
                      <small className="muted">
                        {r.config.model || r.project}
                      </small>
                    </Link>
                    <Link className="secondary" to={"/run/" + r.id}>
                      Open →
                    </Link>
                  </div>
                  <RunStatus run={r} />
                  <progress
                    max="100"
                    value={latest(r, "progress") || 0}
                    aria-label={r.name + " progress"}
                  />
                  <div className="row">
                    <small>
                      {fmt(latest(r, "progress") || 0, 1)}% ·{" "}
                      {fmt((latest(r, "training/tokens_seen") || 0) / 1e6, 2)}M
                      tokens
                    </small>
                    <small>
                      Train {fmt(latest(r, "train/loss"))} · Val{" "}
                      {fmt(latest(r, "val/loss"))}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      <section aria-label="Benchmark queue">
        <RunError error={queue.error} retry={() => void queue.refetch()} />
        {queue.data && (
          <div className="panel" style={{ padding: 20, marginBottom: 20 }}>
            <div className="row">
              <h3>Benchmark queue</h3>
              <small>
                {queue.data.running} running · {queue.data.waiting} waiting ·
                one worker slot for new evaluations
              </small>
            </div>
            {queue.data.items.length ? (
              queue.data.items.map((e) => (
                <div className="legend" key={e.id}>
                  <Link to={"/run/" + e.run_id}>{e.run_name}</Link>
                  <span>
                    {e.status === "queued"
                      ? "Queue #" + e.queue_position
                      : e.current_task || "Starting worker"}{" "}
                    · {e.mode} · {Object.keys(e.results).length}/
                    {e.tasks.length} tasks{" "}
                    <button
                      className="secondary"
                      disabled={action.pending}
                      onClick={async () => {
                        if (
                          await action.execute(
                            "/api/runs/" +
                              e.run_id +
                              "/benchmarks/" +
                              e.id +
                              "/cancel",
                          )
                        )
                          await queue.refetch();
                      }}
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <small>
                No pending evaluations for your models. Open a finished run to
                add benchmarks.
              </small>
            )}
          </div>
        )}
      </section>
      {query.isLoading && <p role="status">Loading runs…</p>}
      <div className="run-list">
        {runs?.length === 0 ? (
          <div className="panel empty">
            <h2>Your first experiment starts here.</h2>
            <p className="muted">
              Mix a few datasets and train a small model in your browser.
            </p>
            <Link className="primary" to="/new">
              Create a training run →
            </Link>
          </div>
        ) : (
          visible.map((r) => (
            <div className="run-item" key={r.id}>
              <input
                type="checkbox"
                aria-label={"Compare " + r.name}
                checked={selected.has(r.id)}
                onChange={(e) => {
                  if (e.target.checked && selected.size === 10) {
                    setMessage("Compare up to 10 runs at a time.");
                    return;
                  }
                  setMessage("");
                  setSelected((previous) => {
                    const next = new Set(previous);
                    next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                    return next;
                  });
                }}
              />
              <Link to={"/run/" + r.id}>
                <h3>{r.name}</h3>
                <small>
                  {r.project} · {new Date(r.started_at).toLocaleString()}
                </small>
              </Link>
              <span className="loss-label muted">
                Loss {fmt(latest(r, "train/loss") ?? latest(r, "loss"))}
              </span>
              <span className={"badge " + r.state}>{r.state}</span>
            </div>
          ))
        )}
      </div>
      {!!runs?.length && !visible.length && (
        <p className="empty muted">No runs match your search.</p>
      )}
    </>
  );
}
