import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  useDashboard,
  type DashboardCheckpoint,
  type CheckpointEvaluation,
} from "./DashboardData";
import { RunArtifact } from "./RunPanels";
import { fmt, RunError, useRunAction } from "./RunData";
import { ChangedSettings, fullScore, RunMonitoring } from "./FocusedMetrics";

function sizeLabel(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1000) return `${fmt(bytes, 0)} B`;
  if (bytes < 1000000) return `${fmt(bytes / 1000, 1)} KB`;
  if (bytes < 1000000000) return `${fmt(bytes / 1000000, 1)} MB`;
  return `${fmt(bytes / 1000000000, 2)} GB`;
}
function TestReview({
  checkpoint,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  checkpoint: DashboardCheckpoint;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="runs-checkpoint-dialog"
      aria-labelledby="test-review-title"
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <div className="runs-dialog-header">
        <h2 id="test-review-title">Verify final test evidence?</h2>
        <button
          type="button"
          className="runs-icon-button"
          aria-label="Close test review"
          disabled={pending}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p>
        <strong>
          {checkpoint.run_name} · step {fmt(checkpoint.step, 0)}
        </strong>
        <br />
        Checkpoint {checkpoint.id}
      </p>
      <p>
        Use full validation for iterative comparisons. Repeatedly checking the
        test split and tuning to its score contaminates final verification.
        Freeze your checkpoint choice before running full WikiText-2 test
        evaluation.
      </p>
      <p>
        This explicitly queues evaluation compute for these saved weights. It
        does not train or resume the model. Results use Track's recorded
        protocol, not a claim of external leaderboard reproduction.
      </p>
      <RunError error={error} />
      <div className="runs-dialog-actions">
        <button
          type="button"
          className="runs-button runs-button-secondary"
          disabled={pending}
          onClick={onClose}
        >
          Keep tuning on validation
        </button>
        <button
          type="button"
          className="runs-button runs-button-primary"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Submitting…" : "Confirm full test verification"}
        </button>
      </div>
    </dialog>
  );
}

type SelectedScore = {
  checkpoint: DashboardCheckpoint;
  evaluation: CheckpointEvaluation;
};
export function CheckpointsPage() {
  const dashboard = useDashboard();
  const action = useRunAction();
  const [params, setParams] = useSearchParams();
  const runId = params.get("run") ?? "";
  const [search, setSearch] = useState("");
  const [workspace, setWorkspace] = useState<"focused" | "all">("focused");
  const [bestOnly, setBestOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const checkpoints = dashboard.data?.checkpoints ?? [];
  const runs = dashboard.data?.runs ?? [];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const run = byId.get(runId);
  const query = search.trim().toLowerCase();
  const rows = checkpoints
    .filter(
      (checkpoint) =>
        (runId
          ? checkpoint.run_id === runId
          : workspace === "all" || byId.get(checkpoint.run_id)?.focused) &&
        (!bestOnly || checkpoint.is_best) &&
        (!query ||
          `${checkpoint.run_name} ${checkpoint.id} ${checkpoint.step} ${checkpoint.sha256 ?? ""}`
            .toLowerCase()
            .includes(query)),
    )
    .sort((a, b) =>
      runId
        ? a.step - b.step || Date.parse(a.created_at) - Date.parse(b.created_at)
        : Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  const visibleEvaluationIds = rows.flatMap((checkpoint) =>
    checkpoint.evaluations.map((evaluation) => evaluation.id),
  );
  const selectedScores: SelectedScore[] = rows.flatMap((checkpoint) =>
    checkpoint.evaluations
      .filter((evaluation) => selected.includes(evaluation.id))
      .map((evaluation) => ({ checkpoint, evaluation })),
  );
  const comparable =
    selectedScores.length === 2 &&
    selectedScores[0].checkpoint.id !== selectedScores[1].checkpoint.id &&
    selectedScores.every(({ evaluation }) => fullScore(evaluation)) &&
    selectedScores[0].evaluation.split === selectedScores[1].evaluation.split &&
    selectedScores[0].evaluation.protocol ===
      selectedScores[1].evaluation.protocol;
  const review = checkpoints.find((checkpoint) => checkpoint.id === reviewId);
  const knownActiveRuns = new Set(
    checkpoints
      .filter((checkpoint) =>
        checkpoint.evaluations.some((evaluation) =>
          ["queued", "running"].includes(evaluation.status),
        ),
      )
      .map((checkpoint) => checkpoint.run_id),
  );
  const scopeKey = `${runId}:${workspace}:${search}:${bestOnly}`;
  useEffect(() => {
    setSelected([]);
  }, [scopeKey]);

  async function evaluate(
    checkpoint: DashboardCheckpoint,
    split: "validation" | "test",
  ) {
    setMessage("");
    const result = await action.execute(
      `/api/runs/${encodeURIComponent(checkpoint.run_id)}/benchmarks`,
      {
        suite: "wikitext2",
        mode: "full",
        checkpoint_id: checkpoint.id,
        split,
      },
    );
    if (result) {
      setMessage(
        `Full ${split} evaluation requested for ${checkpoint.run_name}, step ${checkpoint.step}. An identical completed evaluation may be reused.`,
      );
      setReviewId(null);
    }
    await dashboard.refetch();
  }
  return (
    <div className="dashboard-page checkpoints-page">
      <header className="dashboard-heading">
        <div>
          <h1>Checkpoint monitoring</h1>
          <p>
            Chronology, pinned evaluation evidence and reviewed weights-only
            forks. Full validation guides iteration; test evidence stays
            separate.
          </p>
        </div>
        <Link className="runs-button runs-button-secondary" to="/runs">
          Focused runs
        </Link>
      </header>
      <RunError
        error={dashboard.error}
        retry={() => void dashboard.refetch()}
      />
      <RunError error={action.error} />
      {action.error && (
        <div className="checkpoint-action-recovery">
          <p>
            A run can have only one queued/running evaluation. Refresh its
            status, then retry the explicit action when the worker is free. No
            retry is submitted automatically.
          </p>
          <button
            type="button"
            className="runs-button runs-button-secondary"
            onClick={() => void dashboard.refetch()}
          >
            Refresh evaluation status
          </button>
        </div>
      )}
      {message && (
        <p className="runs-notice" role="status">
          {message}
        </p>
      )}
      <div className="dashboard-filters">
        <label className="field">
          <span>Search checkpoints</span>
          <input
            type="search"
            placeholder="Run name, checkpoint, step or evaluated SHA"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Run scope</span>
          <select
            value={runId}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value) next.set("run", event.target.value);
              else next.delete("run");
              setParams(next);
            }}
          >
            <option value="">All runs in selected workspace</option>
            {runId && !run && (
              <option value={runId}>Unavailable run · {runId}</option>
            )}
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.state}
                {item.focused ? " · focused" : " · archived"}
              </option>
            ))}
          </select>
        </label>
        {!runId && (
          <div className="focus-toggle" aria-label="Checkpoint workspace">
            <button
              type="button"
              aria-pressed={workspace === "focused"}
              onClick={() => setWorkspace("focused")}
            >
              Focused
            </button>
            <button
              type="button"
              aria-pressed={workspace === "all"}
              onClick={() => setWorkspace("all")}
            >
              All runs / archive
            </button>
          </div>
        )}
        <label>
          <input
            type="checkbox"
            checked={bestOnly}
            onChange={(event) => setBestOnly(event.target.checked)}
          />{" "}
          Best training val loss only
        </label>
      </div>
      {run && (
        <section
          className="checkpoint-context"
          aria-label="Selected run context"
        >
          <div>
            <h2>
              <Link to={`/run/${encodeURIComponent(run.id)}`}>{run.name}</Link>{" "}
              <span className={`runs-status runs-status-${run.state}`}>
                {run.state}
              </span>
            </h2>
            <p>
              Family baseline:{" "}
              <Link
                to={`/checkpoints?run=${encodeURIComponent(run.family_id)}`}
              >
                {byId.get(run.family_id)?.name ?? run.family_id}
              </Link>
              {run.parent_run_id && (
                <>
                  {" "}
                  · Fork of{" "}
                  <Link
                    to={`/checkpoints?run=${encodeURIComponent(run.parent_run_id)}`}
                  >
                    {byId.get(run.parent_run_id)?.name ?? run.parent_run_id}
                  </Link>
                </>
              )}
            </p>
            {run.forked_from_checkpoint_id && (
              <p className="checkpoint-id">
                Source checkpoint: {run.forked_from_checkpoint_id} ·
                weights-only, not optimizer resume
              </p>
            )}
            <ChangedSettings
              run={run}
              parent={
                run.parent_run_id ? byId.get(run.parent_run_id) : undefined
              }
            />
            <p>
              Training val loss:{" "}
              {fmt(
                run.latest_metrics["val/loss"] ??
                  run.latest_metrics["validation/loss"] ??
                  run.val_loss_history.at(-1)?.value,
                4,
              )}{" "}
              · not WikiText-2 BYTE_PPL
            </p>
            <nav className="checkpoint-family-links" aria-label="Run family">
              {runs
                .filter(
                  (item) =>
                    item.family_id === run.family_id && item.id !== run.id,
                )
                .map((item) => (
                  <Link
                    key={item.id}
                    to={`/checkpoints?run=${encodeURIComponent(item.id)}`}
                  >
                    {item.name}
                    {item.id === run.family_id ? " · baseline" : " · fork"}
                  </Link>
                ))}
            </nav>
          </div>
          <RunMonitoring run={run} />
        </section>
      )}
      {runId && !run && dashboard.data && (
        <p role="status">
          This run is unavailable or not owned by your account. Choose an
          accessible run above.
        </p>
      )}
      <div className="checkpoint-protocol-note">
        <strong>WikiText-2 BYTE_PPL · lower is better</strong>
        <p>
          Scores require a finished full evaluation with pinned SHA, split and
          Track protocol. Smoke, failed and partial results never rank. Compare
          only the same full protocol and split; training loss is a different
          measurement. Nothing is queued when you open this page.
        </p>
      </div>
      {!!selectedScores.length && (
        <section
          className="checkpoint-comparison"
          aria-label="Checkpoint score comparison"
        >
          <div className="focus-family-header">
            <h2>Selected checkpoint scores ({selectedScores.length}/2)</h2>
            <button
              type="button"
              className="runs-button runs-button-secondary"
              onClick={() => setSelected([])}
            >
              Clear selection
            </button>
          </div>
          {selectedScores.map(({ checkpoint, evaluation }, index) => (
            <p key={evaluation.id}>
              {index === 0 ? "A" : "B"}: {checkpoint.run_name} · step{" "}
              {fmt(checkpoint.step, 0)} · {evaluation.split} ·{" "}
              {evaluation.protocol} · BYTE_PPL{" "}
              {fmt(evaluation.byte_perplexity, 4)}
            </p>
          ))}
          {comparable ? (
            <p>
              <strong>
                B − A:{" "}
                {fmt(
                  (selectedScores[1].evaluation.byte_perplexity ?? 0) -
                    (selectedScores[0].evaluation.byte_perplexity ?? 0),
                  4,
                )}{" "}
                BYTE_PPL
              </strong>{" "}
              · negative is improvement · full{" "}
              {selectedScores[0].evaluation.split}
            </p>
          ) : (
            <p>
              {selectedScores.length === 1
                ? "Select a second checkpoint with a finished full score."
                : "Not comparable: select different checkpoints with the same split and full protocol. No delta is shown."}
            </p>
          )}
        </section>
      )}
      {dashboard.isLoading ? (
        <p role="status">Loading checkpoints…</p>
      ) : (
        dashboard.data && (
          <section
            aria-label="Saved checkpoint chronology"
            className="checkpoint-chronology"
          >
            <div className="dashboard-table-heading">
              <h2>
                {runId
                  ? "Checkpoint chronology · oldest first"
                  : "Saved checkpoints · newest first"}
              </h2>
              <span>
                {fmt(rows.length, 0)} checkpoints · refreshes every 5s
              </span>
            </div>
            {!rows.length ? (
              <div className="dashboard-empty">
                <h3>No matching checkpoints</h3>
                <p>
                  {run
                    ? "Saved checkpoints will appear here as training writes them. You can evaluate a compatible saved snapshot while training continues."
                    : "Choose a focused family or browse archived runs. No baseline is selected implicitly."}
                </p>
                {!runId && (
                  <button
                    type="button"
                    className="runs-button runs-button-secondary"
                    onClick={() => {
                      setWorkspace("all");
                      setSearch("");
                      setBestOnly(false);
                    }}
                  >
                    Browse all saved checkpoints
                  </button>
                )}{" "}
                <Link className="runs-button runs-button-secondary" to="/new">
                  Create training run
                </Link>
              </div>
            ) : (
              rows.map((checkpoint) => {
                const busy = knownActiveRuns.has(checkpoint.run_id);
                const evaluationDisabled =
                  action.pending ||
                  busy ||
                  !checkpoint.can_fork ||
                  !checkpoint.artifact_id;
                const evaluations = [...checkpoint.evaluations].sort(
                  (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
                );
                return (
                  <article key={checkpoint.id} className="checkpoint-card">
                    <div className="checkpoint-card-heading">
                      <div>
                        <h3>
                          <Link
                            to={`/run/${encodeURIComponent(checkpoint.run_id)}`}
                          >
                            {checkpoint.run_name}
                          </Link>{" "}
                          · step {fmt(checkpoint.step, 0)}
                        </h3>
                        <p>
                          {fmt(checkpoint.tokens_seen, 0)} tokens at snapshot ·
                          val loss {fmt(checkpoint.val_loss, 4)}
                          {checkpoint.is_best
                            ? " · best training val loss"
                            : ""}
                        </p>
                      </div>
                      <time dateTime={checkpoint.created_at}>
                        {new Date(checkpoint.created_at).toLocaleString()}
                      </time>
                    </div>
                    <dl className="checkpoint-artifact">
                      <div>
                        <dt>Checkpoint</dt>
                        <dd>{checkpoint.id}</dd>
                      </div>
                      <div>
                        <dt>Artifact</dt>
                        <dd>
                          {checkpoint.artifact_id ?? "Unavailable"} ·{" "}
                          {sizeLabel(checkpoint.size)}
                        </dd>
                      </div>
                      <div>
                        <dt>Evaluated SHA-256</dt>
                        <dd>
                          <code>
                            {checkpoint.sha256 ??
                              "Not yet recorded; evaluation pins the exact artifact."}
                          </code>
                        </dd>
                      </div>
                    </dl>
                    <div className="checkpoint-actions">
                      <button
                        type="button"
                        className="runs-button runs-button-primary"
                        disabled={evaluationDisabled}
                        onClick={() => void evaluate(checkpoint, "validation")}
                      >
                        Evaluate validation
                      </button>
                      <button
                        type="button"
                        className="runs-button runs-button-secondary"
                        disabled={evaluationDisabled}
                        onClick={() => {
                          action.setError("");
                          setReviewId(checkpoint.id);
                        }}
                      >
                        Verify test…
                      </button>
                      {checkpoint.can_fork ? (
                        <Link
                          className="runs-button runs-button-secondary"
                          to={`/new?parent=${encodeURIComponent(checkpoint.run_id)}&checkpoint=${encodeURIComponent(checkpoint.id)}`}
                        >
                          Review weights-only fork
                        </Link>
                      ) : (
                        <span className="muted">
                          No compatible weights for fork / evaluation
                        </span>
                      )}
                      {checkpoint.artifact_id && (
                        <RunArtifact
                          id={checkpoint.artifact_id}
                          name={`checkpoint-${checkpoint.step}.pt`}
                        />
                      )}
                    </div>
                    {busy && (
                      <p className="checkpoint-hint">
                        This run already has an evaluation queued or running.
                        Wait or cancel it before submitting another.
                      </p>
                    )}
                    <div
                      className="checkpoint-evaluations"
                      aria-label={`Evaluations of step ${checkpoint.step}`}
                    >
                      {!evaluations.length ? (
                        <p className="checkpoint-hint">
                          No WikiText-2 evaluation yet. Validation and final
                          test evidence will appear here.
                        </p>
                      ) : (
                        evaluations.map((evaluation) => {
                          const scored = fullScore(evaluation);
                          const selectedCount = selected.filter((id) =>
                            visibleEvaluationIds.includes(id),
                          ).length;
                          return (
                            <section
                              key={evaluation.id}
                              className={`checkpoint-evaluation checkpoint-evaluation-${evaluation.split}`}
                            >
                              <div className="checkpoint-evaluation-heading">
                                <strong>
                                  {evaluation.split === "test"
                                    ? "Final test evidence"
                                    : "Validation comparison"}
                                </strong>
                                <span
                                  className={`runs-status runs-status-${evaluation.status}`}
                                >
                                  {evaluation.status}
                                </span>
                                <span>
                                  {evaluation.mode} · {evaluation.split}
                                </span>
                              </div>
                              <p className="checkpoint-protocol">
                                Track protocol:{" "}
                                <code>{evaluation.protocol}</code>
                              </p>
                              {scored ? (
                                <dl className="checkpoint-metrics">
                                  <div>
                                    <dt>BYTE_PPL ↓</dt>
                                    <dd>
                                      {fmt(evaluation.byte_perplexity, 5)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Bits / byte</dt>
                                    <dd>{fmt(evaluation.bits_per_byte, 5)}</dd>
                                  </div>
                                  <div>
                                    <dt>UTF-8 bytes</dt>
                                    <dd>{fmt(evaluation.num_bytes, 0)}</dd>
                                  </div>
                                  <div>
                                    <dt>Documents</dt>
                                    <dd>{fmt(evaluation.num_documents, 0)}</dd>
                                  </div>
                                </dl>
                              ) : (
                                <p className="checkpoint-hint">
                                  {evaluation.mode === "smoke"
                                    ? "Smoke diagnostics only — not a full comparison score."
                                    : "No complete full score yet."}{" "}
                                  {evaluation.num_bytes !== null && (
                                    <>
                                      Processed {fmt(evaluation.num_bytes, 0)}{" "}
                                      bytes · {fmt(evaluation.num_documents, 0)}{" "}
                                      documents.
                                    </>
                                  )}
                                </p>
                              )}
                              <p className="checkpoint-id">
                                Evaluated checkpoint: {evaluation.checkpoint_id}
                                <br />
                                Pinned SHA-256:{" "}
                                <code>
                                  {evaluation.checkpoint_sha256 ||
                                    "Pending artifact resolution"}
                                </code>
                              </p>
                              <p className="checkpoint-hint">
                                Requested{" "}
                                {new Date(
                                  evaluation.created_at,
                                ).toLocaleString()}
                                {evaluation.ended_at
                                  ? ` · ended ${new Date(evaluation.ended_at).toLocaleString()}`
                                  : ""}
                              </p>
                              {evaluation.error && (
                                <p className="error" role="alert">
                                  {evaluation.error}
                                </p>
                              )}
                              <div className="checkpoint-actions">
                                {scored && (
                                  <label className="checkpoint-score-selection">
                                    <input
                                      type="checkbox"
                                      checked={selected.includes(evaluation.id)}
                                      disabled={
                                        !selected.includes(evaluation.id) &&
                                        selectedCount >= 2
                                      }
                                      onChange={(event) => {
                                        const checked = event.target.checked;
                                        setSelected((previous) =>
                                          checked
                                            ? [
                                                ...previous.filter((id) =>
                                                  visibleEvaluationIds.includes(
                                                    id,
                                                  ),
                                                ),
                                                evaluation.id,
                                              ].slice(0, 2)
                                            : previous.filter(
                                                (id) => id !== evaluation.id,
                                              ),
                                        );
                                      }}
                                    />{" "}
                                    Select full score for comparison
                                  </label>
                                )}
                                {["queued", "running"].includes(
                                  evaluation.status,
                                ) && (
                                  <button
                                    type="button"
                                    className="runs-button runs-button-secondary"
                                    disabled={action.pending}
                                    onClick={async () => {
                                      if (
                                        await action.execute(
                                          `/api/runs/${encodeURIComponent(checkpoint.run_id)}/benchmarks/${encodeURIComponent(evaluation.id)}/cancel`,
                                        )
                                      )
                                        await dashboard.refetch();
                                    }}
                                  >
                                    Cancel evaluation
                                  </button>
                                )}
                              </div>
                            </section>
                          );
                        })
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </section>
        )
      )}
      {review && (
        <TestReview
          checkpoint={review}
          pending={action.pending}
          error={action.error}
          onClose={() => setReviewId(null)}
          onConfirm={() => void evaluate(review, "test")}
        />
      )}
    </div>
  );
}
