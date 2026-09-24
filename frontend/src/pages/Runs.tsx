import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  useDashboard,
  type DashboardCheckpoint,
  type DashboardRun,
} from "./DashboardData";
import { fmt, RunError, useRunAction, useRunQuery } from "./RunData";
import {
  activeFamilyRun,
  ChangedSettings,
  RunMonitoring,
  validationBests,
} from "./FocusedMetrics";
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
const statuses = [
  "all",
  "running",
  "done",
  "stopped",
  "queued",
  "failed",
  "cancelled",
  "interrupted",
];
function statusOf(state: string): string {
  if (["finished", "completed", "done"].includes(state)) return "done";
  if (["stopped", "stopping"].includes(state)) return "stopped";
  return state === "canceled" ? "cancelled" : state;
}
function runGroups(runs: DashboardRun[], allRuns: DashboardRun[]) {
  const families = new Map<string, DashboardRun[]>();
  for (const run of runs) {
    const members = families.get(run.family_id) ?? [];
    members.push(run);
    families.set(run.family_id, members);
  }
  const byId = new Map(allRuns.map((run) => [run.id, run]));
  return [...families].map(([id, members]) => {
    const visibleIds = new Set(members.map((run) => run.id));
    const children = new Map<string, DashboardRun[]>();
    const ordered = [...members].sort(
      (a, b) =>
        Date.parse(a.started_at) - Date.parse(b.started_at) ||
        a.id.localeCompare(b.id),
    );
    for (const run of ordered) {
      if (!run.parent_run_id || run.parent_run_id === run.id) continue;
      const siblings = children.get(run.parent_run_id) ?? [];
      siblings.push(run);
      children.set(run.parent_run_id, siblings);
    }
    const rows: { run: DashboardRun; depth: number }[] = [];
    const visited = new Set<string>();
    function append(root: DashboardRun) {
      const pending = [{ run: root, depth: 0 }];
      while (pending.length) {
        const current = pending.pop();
        if (!current || visited.has(current.run.id)) continue;
        visited.add(current.run.id);
        rows.push(current);
        const descendants = children.get(current.run.id) ?? [];
        for (let index = descendants.length - 1; index >= 0; index--)
          pending.push({ run: descendants[index], depth: current.depth + 1 });
      }
    }
    for (const run of ordered)
      if (!run.parent_run_id || !visibleIds.has(run.parent_run_id)) append(run);
    for (const run of ordered) if (!visited.has(run.id)) append(run);
    const family = allRuns.filter((run) => run.family_id === id);
    return {
      id,
      name: byId.get(id)?.name ?? members[0].name,
      rows,
      family,
      focused: members[0].focused,
      active: family.some(activeFamilyRun),
    };
  });
}
function LossSparkline({
  history,
}: {
  history: DashboardRun["val_loss_history"];
}) {
  const points = history
    .filter(
      (point) => Number.isFinite(point.step) && Number.isFinite(point.value),
    )
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
        Fork {run.name} from saved weights only, not optimizer resume. Review
        configuration before explicitly launching training.
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
            {item.is_best ? " · Best val loss" : ""} · Val loss{" "}
            {fmt(item.val_loss)} · {new Date(item.created_at).toLocaleString()}
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
            to={`/new?parent=${encodeURIComponent(run.id)}&checkpoint=${encodeURIComponent(checkpoint.id)}`}
          >
            Review weights-only fork →
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
  const focusAction = useRunAction();
  const [workspace, setWorkspace] = useState<"focused" | "all">("focused");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [dateScope, setDateScope] = useState("all");
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
        (showArchived ? run.archived : !run.archived) &&
        (workspace === "all" || run.focused) &&
        (dateScope === "all" || Date.parse(run.started_at) >= cutoff) &&
        [run.name, run.project, run.experiment, run.id].some((value) =>
          value.toLowerCase().includes(query),
        ),
    );
    const visible = scope.filter(
      (run) => status === "all" || statusOf(run.state) === status,
    );
    const visibleIds = new Set(visible.map((run) => run.id));
    const checkpoints = (data?.checkpoints ?? []).filter((checkpoint) =>
      visibleIds.has(checkpoint.run_id),
    );
    const byRun = new Map<string, DashboardCheckpoint[]>();
    for (const checkpoint of data?.checkpoints ?? []) {
      const items = byRun.get(checkpoint.run_id) ?? [];
      items.push(checkpoint);
      byRun.set(checkpoint.run_id, items);
    }
    for (const items of byRun.values())
      items.sort((a, b) => b.step - a.step || a.id.localeCompare(b.id));
    const measured = visible.filter(
      (run) =>
        typeof run.gpu_seconds === "number" && Number.isFinite(run.gpu_seconds),
    );
    return {
      allRuns,
      scope,
      visible,
      visibleIds,
      groups: runGroups(visible, allRuns),
      checkpoints,
      byRun,
      bestValidation: validationBests(checkpoints),
      measured,
      gpuSeconds: measured.reduce(
        (total, run) => total + (run.gpu_seconds ?? 0),
        0,
      ),
      byId: new Map(allRuns.map((run) => [run.id, run])),
      focusedFamilies: new Set(
        allRuns.filter((run) => run.focused).map((run) => run.family_id),
      ).size,
    };
  }, [data, dateScope, search, status, workspace, showArchived]);
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
  const forkRun = forkRunId ? view.byId.get(forkRunId) : undefined;
  return (
    <div className="runs-dashboard focused-dashboard">
      <header className="runs-header">
        <div>
          <h1>Focused runs</h1>
          <p className="runs-subtitle">
            One baseline, deliberate forks, measurable progress. Target:
            sub-150M parameters and lower WikiText-2 BYTE_PPL.
          </p>
        </div>
      </header>
      <RunError
        error={dashboard.error}
        retry={() => void dashboard.refetch()}
      />
      <RunError error={action.error} />
      <RunError
        error={focusAction.error}
        retry={() => void dashboard.refetch()}
      />
      {message && (
        <p className="runs-notice" role="status">
          {message}
        </p>
      )}
      <section className="focus-intro" aria-label="Training objective">
        <p>
          <a href="/leaderboard">Fabryka Tiny-ML leaderboard</a>{" "}
          · The native 150M preset has 149.63M parameters. Track's byte-model
          protocol is recorded separately and evaluated on its own pinned board.
        </p>
        <div className="focus-workspace-controls">
          <div className="focus-toggle" aria-label="Workspace scope">
            <button
              type="button"
              aria-pressed={workspace === "focused"}
              onClick={() => setWorkspace("focused")}
            >
              Focused families
            </button>
            <button
              type="button"
              aria-pressed={workspace === "all"}
              onClick={() => setWorkspace("all")}
            >
              All runs / archive
            </button>
          </div>
          <Link className="runs-button runs-button-primary" to="/new">
            Create training run
          </Link>
        </div>
        <p>
          {view.focusedFamilies} focused{" "}
          {view.focusedFamilies === 1 ? "family" : "families"}. Keep a few
          purposeful branches; focus is a workspace choice, not a concurrency
          limit.
        </p>
      </section>
      <div className="runs-filters">
        <label className="runs-filter">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {statuses.map((item) => (
              <option key={item} value={item}>
                {item === "all" ? "All statuses" : item}
              </option>
            ))}
          </select>
        </label>
        <label className="runs-filter">
          <span>Date</span>
          <select
            value={dateScope}
            onChange={(event) => setDateScope(event.target.value)}
          >
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <button
          type="button"
          className="runs-button runs-button-secondary"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
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
            Best WikiText-2 BYTE_PPL
          </span>
          <strong className="runs-summary-value">
            {view.bestValidation.length === 1
              ? fmt(view.bestValidation[0].evaluation.byte_perplexity, 4)
              : "—"}
          </strong>
          <div className="runs-summary-detail">
            {view.bestValidation.length
              ? view.bestValidation.map(({ checkpoint, evaluation }) => (
                  <div className="focus-quality" key={evaluation.protocol}>
                    <Link
                      to={`/checkpoints?run=${encodeURIComponent(checkpoint.run_id)}`}
                    >
                      {checkpoint.run_name} · step {fmt(checkpoint.step, 0)}
                    </Link>
                    {view.bestValidation.length > 1 && (
                      <strong>{fmt(evaluation.byte_perplexity, 4)}</strong>
                    )}
                    <span>Full validation · lower is better</span>
                    <code>{evaluation.protocol}</code>
                  </div>
                ))
              : "No completed full validation evaluation. Smoke and test results do not rank here."}
          </div>
        </article>
        <article className="runs-summary-card">
          <span className="runs-summary-label">
            <Icon name="clock" />
            GPU hours
          </span>
          <strong className="runs-summary-value">
            {fmt(view.measured.length ? view.gpuSeconds / 3600 : null, 2)}
          </strong>
          <span className="runs-summary-detail">
            {view.measured.length
              ? `${view.measured.length} of ${view.visible.length} runs measured${view.measured.length < view.visible.length ? " · partial total" : ""}`
              : "No measured GPU usage"}
          </span>
        </article>
        <article className="runs-summary-card">
          <span className="runs-summary-label">
            <Icon name="database" />
            Saved checkpoints
          </span>
          <strong className="runs-summary-value">
            {data ? fmt(view.checkpoints.length, 0) : "—"}
          </strong>
          <span className="runs-summary-detail">
            Immutable evaluation evidence · weights-only forks reviewed before
            launch
          </span>
        </article>
      </section>
      <section className="runs-table-panel" aria-label="Training families">
        <div className="runs-table-toolbar">
          <strong>
            {workspace === "focused"
              ? "Focused families"
              : "All runs / archive"}
          </strong>
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
        <div className="runs-table-scroll" aria-busy={dashboard.isLoading}>
          {dashboard.isLoading && (
            <p className="runs-empty" role="status">
              Loading runs…
            </p>
          )}
          {data && workspace === "focused" && !view.focusedFamilies ? (
            <div className="runs-empty">
              <h2>Choose a baseline to focus on.</h2>
              <p>
                No old runs are selected automatically. Browse the archive and
                focus a family, or create a deliberate new training run.
              </p>
              <div className="focus-empty-actions">
                <button
                  type="button"
                  className="runs-button runs-button-secondary"
                  onClick={() => setWorkspace("all")}
                >
                  Browse existing baselines
                </button>
                <Link className="runs-button runs-button-primary" to="/new">
                  Create training run
                </Link>
              </div>
            </div>
          ) : data && !view.allRuns.length ? (
            <div className="runs-empty">
              <h2>Your first experiment starts here.</h2>
              <p>
                Create a training run to track real metrics and checkpoints.
              </p>
              <Link className="runs-button runs-button-primary" to="/new">
                Create training run →
              </Link>
            </div>
          ) : data && !view.visible.length ? (
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
                    <th scope="col">Baseline / fork</th>
                    <th scope="col">Status</th>
                    <th scope="col">Val loss</th>
                    <th scope="col">WikiText-2 BYTE_PPL</th>
                    <th scope="col">Training / GPU</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                {view.groups.map((group) => (
                  <tbody key={group.id}>
                    <tr className="runs-group-row">
                      <th scope="rowgroup" colSpan={7}>
                        <div className="focus-family-header">
                          <span>
                            {group.name}
                            <small>
                              Baseline + forks · {group.family.length} runs
                              {group.focused ? " · focused" : " · archived"}
                            </small>
                            {group.active && group.focused && (
                              <small>
                                Archive available after active runs finish
                              </small>
                            )}
                          </span>
                          <button
                            type="button"
                            className="runs-button runs-button-secondary"
                            disabled={
                              focusAction.pending ||
                              (group.focused && group.active)
                            }
                            title={
                              group.focused && group.active
                                ? "Queued, running or stopping families cannot be archived"
                                : "Focus applies to this entire baseline and fork family"
                            }
                            onClick={async () => {
                              const result = await focusAction.execute(
                                `/api/runs/${encodeURIComponent(group.rows[0].run.id)}/focus`,
                                { focused: !group.focused },
                                "patch",
                              );
                              if (result)
                                setMessage(
                                  group.focused
                                    ? "Family archived. Recover it in All runs / archive."
                                    : "Family focused.",
                                );
                              await dashboard.refetch();
                            }}
                          >
                            {group.focused ? "Archive family" : "Focus family"}
                          </button>
                        </div>
                      </th>
                    </tr>
                    {group.rows.map(({ run, depth }) => {
                      const parent = run.parent_run_id
                        ? view.byId.get(run.parent_run_id)
                        : undefined;
                      const checkpoints = view.byRun.get(run.id) ?? [];
                      const forkable = checkpoints.filter(
                        (checkpoint) => checkpoint.can_fork,
                      );
                      const scores = validationBests(checkpoints);
                      const loss =
                        run.latest_metrics["val/loss"] ??
                        run.latest_metrics["validation/loss"] ??
                        run.val_loss_history.at(-1)?.value;
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
                          className={`runs-row${depth ? " runs-row-fork" : ""}`}
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
                                paddingInlineStart: Math.min(depth, 6) * 18,
                              }}
                            >
                              {depth > 0 && (
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
                                  {new Date(
                                    run.started_at,
                                  ).toLocaleDateString()}
                                </span>
                                {run.parent_run_id && (
                                  <span className="runs-parent-note">
                                    Weights-only fork of{" "}
                                    {parent?.name ?? run.parent_run_id}
                                  </span>
                                )}
                                <ChangedSettings run={run} parent={parent} />
                                <Link
                                  className="runs-run-meta"
                                  to={`/checkpoints?run=${encodeURIComponent(run.id)}`}
                                >
                                  {run.checkpoint_count} checkpoints · monitor &
                                  evaluate
                                </Link>
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
                              {run.state === "stopping"
                                ? "stopping"
                                : statusOf(run.state)}
                            </span>
                          </td>
                          <td>
                            <div className="runs-loss">
                              <span>{fmt(loss, 4)}</span>
                              <LossSparkline history={run.val_loss_history} />
                            </div>
                          </td>
                          <td>
                            <div className="focus-quality">
                              {scores.length ? (
                                scores.map(({ checkpoint, evaluation }) => (
                                  <div
                                    className="focus-quality"
                                    key={evaluation.protocol}
                                  >
                                    <strong>
                                      {fmt(evaluation.byte_perplexity, 4)}
                                    </strong>
                                    <small>
                                      Full validation · step{" "}
                                      {fmt(checkpoint.step, 0)}
                                    </small>
                                    <code>{evaluation.protocol}</code>
                                  </div>
                                ))
                              ) : (
                                <span>
                                  —<small>No full validation score</small>
                                </span>
                              )}
                              <Link
                                to={`/checkpoints?run=${encodeURIComponent(run.id)}`}
                              >
                                Validation / final test evidence
                              </Link>
                            </div>
                          </td>
                          <td>
                            <RunMonitoring run={run} />
                          </td>
                          <td>
                            <div className="runs-row-actions">
                              <Link
                                className="runs-open"
                                to={`/run/${encodeURIComponent(run.id)}`}
                              >
                                Open
                              </Link>
                              {run.can_fork && forkable.length ? (
                                <button
                                  type="button"
                                  className="runs-button runs-button-secondary runs-fork-button"
                                  onClick={() => setForkRunId(run.id)}
                                >
                                  {retry ? "Retry fork" : "Fork weights"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="runs-button runs-button-secondary runs-fork-button"
                                  disabled
                                  title="No compatible saved checkpoint available"
                                >
                                  Fork weights
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
            <span>Select 2–10 runs for real comparison charts.</span>
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
              Fork / retry uses saved weights, not optimizer resume. Review
              before launch.
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
                  <Link
                    to={`/checkpoints?run=${encodeURIComponent(item.run_id)}`}
                  >
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
                      ) {
                        await queue.refetch();
                        await dashboard.refetch();
                      }
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
                No pending evaluations. Open a run's checkpoints to explicitly
                evaluate saved weights, including while training continues.
              </p>
            ))}
        </div>
      </details>
      {forkRun && (
        <CheckpointDialog
          key={forkRun.id}
          run={forkRun}
          checkpoints={(view.byRun.get(forkRun.id) ?? []).filter(
            (checkpoint) => checkpoint.can_fork,
          )}
          onClose={() => setForkRunId(null)}
        />
      )}
    </div>
  );
}
