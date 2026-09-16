import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  useDashboard,
  type DashboardCheckpoint,
  type DashboardRun,
} from "./DashboardData";
import { fmt, RunError, useRunAction, useRunQuery } from "./RunData";
import { Icon } from "../Icons";

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
type Status =
  | "all"
  | "running"
  | "done"
  | "stopped"
  | "queued"
  | "failed"
  | "cancelled"
  | "interrupted";
type DateScope = "all" | "7" | "30";
type TreeRow = { run: DashboardRun; depth: number; parentVisible: boolean };
type RunGroup = { name: string; rows: TreeRow[] };
const statuses: { value: Status; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "stopped", label: "Stopped" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "interrupted", label: "Interrupted" },
];
const f1Keys = [
  "val/f1",
  "val/f1_score",
  "validation/f1",
  "validation/f1_score",
  "eval/f1",
  "eval/f1_score",
  "f1",
  "f1_score",
  "test/f1",
  "test/f1_score",
];

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function statusOf(state: string): string {
  if (["finished", "completed", "done"].includes(state)) return "done";
  if (["stopped", "stopping"].includes(state)) return "stopped";
  if (state === "canceled") return "cancelled";
  return state;
}
function statusLabel(state: string): string {
  if (state === "stopping") return "Stopping";
  const status = statusOf(state);
  return statuses.find((item) => item.value === status)?.label ?? state;
}
function f1(run: DashboardRun) {
  const key = f1Keys.find((candidate) => finite(run.latest_metrics[candidate]));
  return key ? { key, value: run.latest_metrics[key] } : null;
}
function forkUrl(runId: string, checkpointId: string): string {
  return `/new?parent=${encodeURIComponent(runId)}&checkpoint=${encodeURIComponent(checkpointId)}`;
}
function bytes(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${fmt(value / 1024 ** unit, 1)} ${units[unit]}`;
}
function runGroups(runs: DashboardRun[]): RunGroup[] {
  const ordered = [...runs].sort((a, b) => {
    const aTime = Date.parse(a.started_at);
    const bTime = Date.parse(b.started_at);
    return (
      (Number.isFinite(bTime) ? bTime : 0) -
        (Number.isFinite(aTime) ? aTime : 0) || a.id.localeCompare(b.id)
    );
  });
  const byId = new Map(ordered.map((run) => [run.id, run]));
  const children = new Map<string, DashboardRun[]>();
  for (const run of ordered) {
    if (
      run.parent_run_id &&
      run.parent_run_id !== run.id &&
      byId.has(run.parent_run_id)
    ) {
      const siblings = children.get(run.parent_run_id) ?? [];
      siblings.push(run);
      children.set(run.parent_run_id, siblings);
    }
  }
  const visited = new Set<string>();
  const groups = new Map<string, RunGroup>();
  function appendTree(root: DashboardRun) {
    const name = root.experiment || root.project || "Ungrouped runs";
    const group = groups.get(name) ?? { name, rows: [] };
    groups.set(name, group);
    const pending = [{ run: root, depth: 0 }];
    while (pending.length) {
      const current = pending.pop();
      if (!current || visited.has(current.run.id)) continue;
      visited.add(current.run.id);
      group.rows.push({ ...current, parentVisible: current.depth > 0 });
      const descendants = children.get(current.run.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--) {
        pending.push({ run: descendants[index], depth: current.depth + 1 });
      }
    }
  }
  for (const run of ordered) {
    if (
      !run.parent_run_id ||
      !byId.has(run.parent_run_id) ||
      run.parent_run_id === run.id
    )
      appendTree(run);
  }
  // Malformed cycles have no root. Render each remaining component once.
  for (const run of ordered) if (!visited.has(run.id)) appendTree(run);
  return [...groups.values()];
}
function LossSparkline({
  history,
}: {
  history: DashboardRun["val_loss_history"];
}) {
  const points = history
    .filter((point) => finite(point.step) && finite(point.value))
    .sort((a, b) => a.step - b.step);
  if (points.length < 2) return null;
  const minStep = points[0].step;
  const maxStep = points[points.length - 1].step;
  let minValue = points[0].value;
  let maxValue = minValue;
  for (const point of points) {
    minValue = Math.min(minValue, point.value);
    maxValue = Math.max(maxValue, point.value);
  }
  const path = points
    .map((point) => {
      const x =
        maxStep === minStep
          ? 46
          : 2 + ((point.step - minStep) / (maxStep - minStep)) * 88;
      const y =
        maxValue === minValue
          ? 15
          : 28 - ((point.value - minValue) / (maxValue - minValue)) * 26;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      className="runs-sparkline"
      viewBox="0 0 92 30"
      width="92"
      height="30"
      role="img"
      aria-label={`Validation loss history: ${fmt(points[0].value)} to ${fmt(points[points.length - 1].value)}`}
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CheckpointDialog({
  run,
  checkpoints,
  onClose,
}: {
  run: DashboardRun;
  checkpoints: DashboardCheckpoint[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preferred =
    checkpoints.find(
      (checkpoint) => checkpoint.id === run.best_checkpoint_id,
    ) ??
    checkpoints.find((checkpoint) => checkpoint.is_best) ??
    checkpoints.find(
      (checkpoint) => checkpoint.id === run.latest_checkpoint_id,
    ) ??
    checkpoints[0];
  const [chosen, setChosen] = useState(preferred?.id ?? "");
  const checkpoint = checkpoints.find((item) => item.id === chosen);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="runs-checkpoint-dialog"
      aria-labelledby="runs-checkpoint-title"
      onCancel={onClose}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <div className="runs-dialog-header">
        <h2 id="runs-checkpoint-title">Choose a checkpoint</h2>
        <button
          type="button"
          className="runs-icon-button"
          aria-label="Close checkpoint selection"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p>
        Fork {run.name} from saved weights. Review the training configuration
        before explicitly launching a new run.
      </p>
      <label className="runs-filter" htmlFor="runs-checkpoint-select">
        Checkpoint
      </label>
      <select
        id="runs-checkpoint-select"
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
      >
        {checkpoints.map((item) => (
          <option key={item.id} value={item.id}>
            Step {fmt(item.step, 0)}
            {item.is_best ? " · Best" : ""} · Val loss {fmt(item.val_loss)} ·{" "}
            {new Date(item.created_at).toLocaleString()}
          </option>
        ))}
      </select>
      {!checkpoint && (
        <p role="status">
          This checkpoint is no longer available. Choose another checkpoint.
        </p>
      )}
      <div className="runs-dialog-actions">
        <button
          type="button"
          className="runs-button runs-button-secondary"
          onClick={onClose}
        >
          Cancel
        </button>
        {checkpoint && (
          <Link
            className="runs-button runs-button-primary"
            to={forkUrl(run.id, checkpoint.id)}
          >
            Review fork →
          </Link>
        )}
      </div>
    </dialog>
  );
}

export function RunsPage() {
  const navigate = useNavigate();
  const dashboard = useDashboard();
  const queue = useRunQuery<Queue>("/api/benchmarks/queue", 5000);
  const action = useRunAction();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [dateScope, setDateScope] = useState<DateScope>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [forkRunId, setForkRunId] = useState<string | null>(null);
  const data = dashboard.data;
  const view = useMemo(() => {
    const allRuns = data?.runs ?? [];
    const cutoff =
      dateScope === "all"
        ? -Infinity
        : Date.now() - Number(dateScope) * 86400000;
    const query = search.trim().toLowerCase();
    const scope = allRuns.filter(
      (run) =>
        (dateScope === "all" || Date.parse(run.started_at) >= cutoff) &&
        [run.name, run.project, run.experiment, run.id].some((value) =>
          value.toLowerCase().includes(query),
        ),
    );
    const visible = scope.filter(
      (run) => status === "all" || statusOf(run.state) === status,
    );
    const visibleIds = new Set(visible.map((run) => run.id));
    const checkpoints = (data?.checkpoints ?? []).filter(
      (checkpoint) =>
        visibleIds.has(checkpoint.run_id) &&
        (dateScope === "all" || Date.parse(checkpoint.created_at) >= cutoff),
    );
    const metricKey = f1Keys.find((key) =>
      visible.some((run) => finite(run.latest_metrics[key])),
    );
    let bestF1: { run: DashboardRun; value: number; key: string } | null = null;
    let gpuSeconds = 0;
    let measuredRuns = 0;
    for (const run of visible) {
      if (
        metricKey &&
        finite(run.latest_metrics[metricKey]) &&
        (!bestF1 || run.latest_metrics[metricKey] > bestF1.value)
      ) {
        bestF1 = { run, value: run.latest_metrics[metricKey], key: metricKey };
      }
      if (finite(run.gpu_seconds)) {
        gpuSeconds += run.gpu_seconds;
        measuredRuns++;
      }
    }
    let storedBytes = 0;
    let measuredCheckpoints = 0;
    const storedArtifacts = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (finite(checkpoint.size)) {
        const storageId = checkpoint.artifact_id ?? checkpoint.id;
        if (!storedArtifacts.has(storageId)) {
          storedBytes += checkpoint.size;
          storedArtifacts.add(storageId);
        }
        measuredCheckpoints++;
      }
    }
    const forkable = new Map<string, DashboardCheckpoint[]>();
    for (const checkpoint of data?.checkpoints ?? []) {
      if (!checkpoint.can_fork) continue;
      const items = forkable.get(checkpoint.run_id) ?? [];
      items.push(checkpoint);
      forkable.set(checkpoint.run_id, items);
    }
    for (const items of forkable.values())
      items.sort((a, b) => b.step - a.step || a.id.localeCompare(b.id));
    return {
      allRuns,
      scope,
      visible,
      visibleIds,
      groups: runGroups(visible),
      checkpoints,
      bestF1,
      gpuSeconds,
      measuredRuns,
      storedBytes,
      measuredCheckpoints,
      forkable,
      byId: new Map(allRuns.map((run) => [run.id, run])),
    };
  }, [data, dateScope, search, status]);
  useEffect(() => {
    setSelected((previous) => {
      const next = new Set(
        [...previous].filter((id) => view.visibleIds.has(id)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [view.visibleIds]);
  const visibleSelection = [...selected].filter((id) =>
    view.visibleIds.has(id),
  );
  const tabs = statuses.filter(
    (item, index) =>
      index < 5 ||
      view.scope.some((run) => statusOf(run.state) === item.value) ||
      status === item.value,
  );
  const forkRun = forkRunId ? view.byId.get(forkRunId) : undefined;

  return (
    <div className="runs-dashboard">
      <header className="runs-header">
        <div>
          <h1>My runs</h1>
          <p className="runs-subtitle">
            Grouped by experiment. Forks sit under their parent, so the
            comparison is structural, not manual.
          </p>
        </div>
      </header>
      <RunError
        error={dashboard.error}
        retry={() => void dashboard.refetch()}
      />
      <RunError error={action.error} />
      {message && (
        <p className="runs-notice" role="status">
          {message}
        </p>
      )}
      <div className="runs-filters">
        <label className="runs-filter">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Status)}
          >
            {statuses.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label === "All" ? "All statuses" : item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="runs-filter">
          <span>Date</span>
          <select
            value={dateScope}
            onChange={(event) => setDateScope(event.target.value as DateScope)}
          >
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <button
          type="button"
          className="runs-button runs-button-secondary runs-compare"
          disabled={visibleSelection.length < 2 || visibleSelection.length > 10}
          onClick={() =>
            navigate(
              "/compare/" + visibleSelection.map(encodeURIComponent).join(","),
            )
          }
        >
          Compare
          {visibleSelection.length ? ` (${visibleSelection.length})` : ""}
        </button>
      </div>
      <section className="runs-summary" aria-label="Summary of filtered runs">
        <article className="runs-summary-card">
          <span className="runs-summary-label">
            <Icon name="trend" />
            Best F1
            {dateScope === "7"
              ? " · last 7 days"
              : dateScope === "30"
                ? " · last 30 days"
                : ""}
          </span>
          <strong className="runs-summary-value">
            {fmt(view.bestF1?.value, 4)}
          </strong>
          <span className="runs-summary-detail">
            {view.bestF1 ? (
              <>
                <Link to={`/run/${encodeURIComponent(view.bestF1.run.id)}`}>
                  {view.bestF1.run.name}
                </Link>{" "}
                · {view.bestF1.key}
              </>
            ) : (
              "No F1 metric reported"
            )}
          </span>
        </article>
        <article className="runs-summary-card">
          <span className="runs-summary-label">
            <Icon name="clock" />
            GPU hours
          </span>
          <strong className="runs-summary-value">
            {fmt(view.measuredRuns ? view.gpuSeconds / 3600 : undefined, 2)}
          </strong>
          <span className="runs-summary-detail">
            {view.measuredRuns
              ? `${view.measuredRuns} of ${view.visible.length} runs measured${view.measuredRuns < view.visible.length ? " · partial total" : ""}`
              : "No measured GPU usage"}
          </span>
        </article>
        <article className="runs-summary-card">
          <span className="runs-summary-label">
            <Icon name="database" />
            Checkpoints stored
          </span>
          <strong className="runs-summary-value">
            {data ? fmt(view.checkpoints.length, 0) : "—"}
          </strong>
          <span className="runs-summary-detail">
            {data
              ? `${view.measuredCheckpoints || view.checkpoints.length === 0 ? bytes(view.storedBytes) : "—"} stored${view.measuredCheckpoints < view.checkpoints.length ? " · size incomplete" : ""}`
              : "Waiting for checkpoint data"}
          </span>
        </article>
      </section>
      <section className="runs-table-panel" aria-label="Training runs">
        <div className="runs-table-toolbar">
          <div className="runs-tabs" role="tablist" aria-label="Run status">
            {tabs.map((item, index) => (
              <button
                type="button"
                className={`runs-tab${status === item.value ? " runs-tab-active" : ""}`}
                key={item.value}
                id={`runs-tab-${item.value}`}
                role="tab"
                aria-selected={status === item.value}
                aria-controls="runs-table-content"
                tabIndex={status === item.value ? 0 : -1}
                onClick={() => setStatus(item.value)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === "ArrowRight")
                    next = (index + 1) % tabs.length;
                  else if (event.key === "ArrowLeft")
                    next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  setStatus(tabs[next].value);
                  const buttons =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      "[role=tab]",
                    );
                  buttons?.[next]?.focus();
                }}
              >
                {item.label}
                <span className="runs-tab-count">
                  {data
                    ? view.scope.filter(
                        (run) =>
                          item.value === "all" ||
                          statusOf(run.state) === item.value,
                      ).length
                    : "—"}
                </span>
              </button>
            ))}
          </div>
          <label className="runs-search">
            <Icon name="search" />
            <span className="runs-sr-only">Search runs</span>
            <input
              type="search"
              placeholder="Search runs…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div
          id="runs-table-content"
          role="tabpanel"
          aria-labelledby={`runs-tab-${status}`}
          className="runs-table-scroll"
          aria-busy={dashboard.isLoading}
        >
          {dashboard.isLoading && (
            <p className="runs-empty" role="status">
              Loading runs…
            </p>
          )}
          {data && view.allRuns.length === 0 ? (
            <div className="runs-empty">
              <h2>Your first experiment starts here.</h2>
              <p>
                Create a training run to track real metrics and checkpoints.
              </p>
              <Link className="runs-button runs-button-primary" to="/new">
                Create a training run →
              </Link>
            </div>
          ) : data && view.visible.length === 0 ? (
            <div className="runs-empty">
              <p>No runs match these filters.</p>
              <button
                type="button"
                className="runs-button runs-button-secondary"
                onClick={() => {
                  setSearch("");
                  setStatus("all");
                  setDateScope("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            data && (
              <table className="runs-table">
                <thead>
                  <tr>
                    <th scope="col" className="runs-selection">
                      <span className="runs-sr-only">Compare selection</span>
                    </th>
                    <th scope="col">Run</th>
                    <th scope="col">Status</th>
                    <th scope="col">Val loss</th>
                    <th scope="col">F1</th>
                    <th scope="col">Step</th>
                    <th scope="col">
                      <span className="runs-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                {view.groups.map((group) => (
                  <tbody key={group.name}>
                    <tr className="runs-group-row">
                      <th scope="rowgroup" colSpan={7}>
                        {group.name}
                        <span>{group.rows.length} runs</span>
                      </th>
                    </tr>
                    {group.rows.map(({ run, depth, parentVisible }) => {
                      const score = f1(run);
                      const parent = run.parent_run_id
                        ? view.byId.get(run.parent_run_id)
                        : undefined;
                      const baseline =
                        score && parent
                          ? parent.latest_metrics[score.key]
                          : undefined;
                      const delta =
                        score && finite(baseline) && parent?.id !== run.id
                          ? score.value - baseline
                          : null;
                      const loss =
                        run.latest_metrics["val/loss"] ??
                        run.latest_metrics["validation/loss"] ??
                        run.val_loss_history.at(-1)?.value;
                      const checkpoints = view.forkable.get(run.id) ?? [];
                      const canFork = run.can_fork && checkpoints.length > 0;
                      const retry =
                        [
                          "failed",
                          "cancelled",
                          "interrupted",
                          "stopped",
                        ].includes(statusOf(run.state)) &&
                        run.state !== "stopping";
                      return (
                        <tr
                          key={run.id}
                          className={`runs-row${parentVisible ? " runs-row-fork" : ""}`}
                        >
                          <td className="runs-selection">
                            <input
                              type="checkbox"
                              aria-label={`Compare ${run.name}`}
                              checked={selected.has(run.id)}
                              onChange={(event) => {
                                if (
                                  event.target.checked &&
                                  selected.size >= 10
                                ) {
                                  setMessage(
                                    "Compare up to 10 runs at a time.",
                                  );
                                  return;
                                }
                                setMessage("");
                                const checked = event.target.checked;
                                setSelected((previous) => {
                                  const next = new Set(previous);
                                  if (checked) next.add(run.id);
                                  else next.delete(run.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <th scope="row" className="runs-name-cell">
                            <div
                              className="runs-run-name"
                              style={{
                                paddingInlineStart: Math.min(depth, 6) * 22,
                              }}
                            >
                              {parentVisible && (
                                <span
                                  className="runs-fork-branch"
                                  aria-hidden="true"
                                >
                                  ↳
                                </span>
                              )}
                              <div>
                                <Link
                                  className="runs-name"
                                  to={`/run/${encodeURIComponent(run.id)}`}
                                >
                                  {run.name}
                                </Link>
                                <span className="runs-run-meta">
                                  {run.project} ·{" "}
                                  <time dateTime={run.started_at}>
                                    {new Date(
                                      run.started_at,
                                    ).toLocaleDateString(undefined, {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })}
                                  </time>
                                </span>
                                {run.parent_run_id && (
                                  <span className="runs-parent-note">
                                    {parentVisible
                                      ? `Fork of ${parent?.name ?? run.parent_run_id}`
                                      : parent
                                        ? `Parent: ${parent.name} · outside this branch`
                                        : "Fork · parent unavailable"}
                                  </span>
                                )}
                              </div>
                            </div>
                          </th>
                          <td>
                            <span
                              className={`runs-status runs-status-${statusOf(run.state)}`}
                            >
                              <span
                                className="runs-status-dot"
                                aria-hidden="true"
                              />
                              {statusLabel(run.state)}
                            </span>
                          </td>
                          <td>
                            <div className="runs-loss">
                              <span>{fmt(loss, 4)}</span>
                              <LossSparkline history={run.val_loss_history} />
                            </div>
                          </td>
                          <td>
                            <div className="runs-f1" title={score?.key}>
                              <span>{fmt(score?.value, 4)}</span>
                              {delta !== null && (
                                <small
                                  className={`runs-delta ${delta > 0 ? "runs-delta-positive" : delta < 0 ? "runs-delta-negative" : "runs-delta-neutral"}`}
                                  title={`${score?.key} difference from ${parent?.name}`}
                                >
                                  {delta > 0 ? "+" : ""}
                                  {fmt(delta, 4)} vs parent
                                </small>
                              )}
                            </div>
                          </td>
                          <td className="runs-step">{fmt(run.step, 0)}</td>
                          <td>
                            <div className="runs-row-actions">
                              <Link
                                className="runs-open"
                                to={`/run/${encodeURIComponent(run.id)}`}
                              >
                                Open
                                <span className="runs-sr-only">
                                  {" "}
                                  {run.name}
                                </span>
                              </Link>
                              {canFork ? (
                                checkpoints.length === 1 ? (
                                  <Link
                                    className="runs-button runs-button-secondary runs-fork-button"
                                    to={forkUrl(run.id, checkpoints[0].id)}
                                  >
                                    {retry ? "Retry" : "Fork"}
                                    <span className="runs-sr-only">
                                      {" "}
                                      {run.name} from checkpoint
                                    </span>
                                  </Link>
                                ) : (
                                  <button
                                    type="button"
                                    className="runs-button runs-button-secondary runs-fork-button"
                                    onClick={() => setForkRunId(run.id)}
                                  >
                                    {retry ? "Retry" : "Fork"}
                                    <span className="runs-sr-only">
                                      {" "}
                                      {run.name} from checkpoint
                                    </span>
                                  </button>
                                )
                              ) : (
                                <button
                                  type="button"
                                  className="runs-button runs-button-secondary runs-fork-button"
                                  disabled
                                  title="No compatible saved checkpoint available"
                                >
                                  {retry ? "Retry" : "Fork"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            )
          )}
        </div>
        {!!view.visible.length && (
          <div className="runs-table-footer">
            <span>Select 2–10 runs to compare.</span>
            {visibleSelection.length > 0 && (
              <button
                type="button"
                className="runs-clear-selection"
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            )}
            <span>
              Fork and Retry open a review step; they do not launch training.
            </span>
          </div>
        )}
      </section>
      <details className="runs-benchmark-queue">
        <summary>
          Benchmark queue
          {queue.data
            ? ` · ${queue.data.running} running · ${queue.data.waiting} waiting`
            : ""}
        </summary>
        <div className="runs-queue-content">
          <RunError error={queue.error} retry={() => void queue.refetch()} />
          {queue.isLoading && <p role="status">Loading benchmark queue…</p>}
          {queue.data &&
            (queue.data.items.length ? (
              queue.data.items.map((item) => (
                <div className="runs-queue-item" key={item.id}>
                  <Link to={`/run/${encodeURIComponent(item.run_id)}`}>
                    {item.run_name}
                  </Link>
                  <span>
                    {item.status === "queued"
                      ? `Queue #${item.queue_position ?? "—"}`
                      : item.current_task || "Starting worker"}{" "}
                    · {item.mode} · {Object.keys(item.results).length}/
                    {item.tasks.length} tasks
                  </span>
                  <button
                    type="button"
                    className="runs-button runs-button-secondary"
                    disabled={action.pending}
                    onClick={async () => {
                      if (
                        await action.execute(
                          `/api/runs/${encodeURIComponent(item.run_id)}/benchmarks/${encodeURIComponent(item.id)}/cancel`,
                        )
                      )
                        await queue.refetch();
                    }}
                  >
                    Cancel
                    <span className="runs-sr-only">
                      {" "}
                      benchmark for {item.run_name}
                    </span>
                  </button>
                </div>
              ))
            ) : (
              <p>
                No pending evaluations for your models. Open a finished run to
                add benchmarks.
              </p>
            ))}
        </div>
      </details>
      {forkRun && (
        <CheckpointDialog
          key={forkRun.id}
          run={forkRun}
          checkpoints={view.forkable.get(forkRun.id) ?? []}
          onClose={() => setForkRunId(null)}
        />
      )}
    </div>
  );
}
