import { useState } from "react";
import { Link } from "react-router";
import { useDashboard } from "./DashboardData";
import { RunArtifact } from "./RunPanels";
import { fmt } from "./RunData";

function sizeLabel(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1000) return `${fmt(bytes, 0)} B`;
  if (bytes < 1000000) return `${fmt(bytes / 1000, 1)} KB`;
  if (bytes < 1000000000) return `${fmt(bytes / 1000000, 1)} MB`;
  return `${fmt(bytes / 1000000000, 2)} GB`;
}

export function CheckpointsPage() {
  const dashboard = useDashboard();
  const [search, setSearch] = useState("");
  const [runId, setRunId] = useState("");
  const [bestOnly, setBestOnly] = useState(false);
  const checkpoints = dashboard.data?.checkpoints || [];
  const query = search.trim().toLowerCase();
  const rows = checkpoints.filter(
    (checkpoint) =>
      (!runId || checkpoint.run_id === runId) &&
      (!bestOnly || checkpoint.is_best) &&
      (!query ||
        `${checkpoint.run_name} ${checkpoint.id} ${checkpoint.step}`
          .toLowerCase()
          .includes(query)),
  );
  const runs = new Map(
    checkpoints.map((checkpoint) => [checkpoint.run_id, checkpoint.run_name]),
  );
  return (
    <div className="dashboard-page checkpoints-page">
      <header className="dashboard-heading">
        <div>
          <h1>Checkpoints</h1>
          <p>
            Saved model weights from your runs. Inspect, download, or start a
            reviewed fork.
          </p>
        </div>
        <Link className="primary" to="/new">
          New run
        </Link>
      </header>
      <div className="dashboard-filters">
        <label className="field">
          <span>Search checkpoints</span>
          <input
            type="search"
            placeholder="Run name, checkpoint, or step"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Run</span>
          <select
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            <option value="">All runs</option>
            {Array.from(runs, ([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={bestOnly}
            onChange={(event) => setBestOnly(event.target.checked)}
          />{" "}
          Best checkpoints only
        </label>
      </div>
      {dashboard.error && (
        <p className="error" role="alert">
          {dashboard.error.message}
        </p>
      )}
      {dashboard.isLoading ? (
        <p role="status">Loading checkpoints…</p>
      ) : (
        !dashboard.error && (
          <section className="dashboard-table-card">
            <div className="dashboard-table-heading">
              <h2>Saved checkpoints</h2>
              <span>
                {fmt(rows.length, 0)}{" "}
                {rows.length === 1 ? "checkpoint" : "checkpoints"}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="dashboard-empty">
                <h3>
                  {checkpoints.length
                    ? "No matching checkpoints"
                    : "No checkpoints yet"}
                </h3>
                <p>
                  {checkpoints.length
                    ? "Try another search or run filter."
                    : "Train a model to save checkpoints here. A fork always requires review before launch."}
                </p>
              </div>
            ) : (
              <div className="dashboard-table-scroll">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th>Run / checkpoint</th>
                      <th>Step</th>
                      <th>Val loss</th>
                      <th>Selection</th>
                      <th>Created</th>
                      <th>Size</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((checkpoint) => (
                      <tr key={checkpoint.id}>
                        <td>
                          <Link
                            className="dashboard-run-name"
                            to={`/run/${encodeURIComponent(checkpoint.run_id)}`}
                          >
                            {checkpoint.run_name}
                          </Link>
                          <small className="dashboard-run-meta">
                            {checkpoint.id}
                          </small>
                        </td>
                        <td>{fmt(checkpoint.step, 0)}</td>
                        <td>{fmt(checkpoint.val_loss, 4)}</td>
                        <td>
                          {checkpoint.is_best ? (
                            <span className="dashboard-status status-finished">
                              Best
                            </span>
                          ) : (
                            "Saved"
                          )}
                        </td>
                        <td>
                          {Number.isNaN(Date.parse(checkpoint.created_at))
                            ? "—"
                            : new Date(checkpoint.created_at).toLocaleString()}
                        </td>
                        <td>{sizeLabel(checkpoint.size)}</td>
                        <td>
                          <div className="dashboard-row-actions">
                            {checkpoint.artifact_id ? (
                              <RunArtifact
                                id={checkpoint.artifact_id}
                                name={`checkpoint-${checkpoint.step}.pt`}
                              />
                            ) : (
                              <span className="muted">No artifact</span>
                            )}
                            {checkpoint.can_fork ? (
                              <Link
                                className="secondary"
                                to={`/new?parent=${encodeURIComponent(checkpoint.run_id)}&checkpoint=${encodeURIComponent(checkpoint.id)}`}
                              >
                                Fork
                              </Link>
                            ) : (
                              <span
                                className="muted"
                                title="A supported model checkpoint with an available artifact is required."
                              >
                                Fork unavailable
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      )}
    </div>
  );
}
