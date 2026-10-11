import { useState } from "react";
import { Link } from "react-router";
import { PageTop } from "../PageTop";
import { RunError, useRunQuery } from "./RunData";

type PublicRun = {
  id: string;
  name: string;
  state: string;
  started_at: string;
  ended_at: string | null;
};

const startedDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
// SQLite returns UTC timestamps without a timezone; preserve explicit offsets.
const runStartedAt = (value: string) =>
  new Date(value + (/Z|[+-]\d\d:\d\d$/i.test(value) ? "" : "Z"));

export function PublicRunsPage() {
  const publicRuns = useRunQuery<PublicRun[]>("/api/public/runs", 10000);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [started, setStarted] = useState("");
  const query = search.trim().toLowerCase();
  const states = Array.from(
    new Set([...(publicRuns.data?.map((run) => run.state) ?? []), ...(state ? [state] : [])]),
  ).sort((a, b) => a.localeCompare(b));
  const cutoff = started ? Date.now() - Number(started) * 86400000 : 0;
  const matchingRuns = publicRuns.data?.filter(
    (run) =>
      run.name.toLowerCase().includes(query) &&
      (!state || run.state === state) &&
      (!started || runStartedAt(run.started_at).getTime() >= cutoff),
  );

  return (
    <>
      <PageTop
        description="Explore everyone's runs, including training in progress. Runs are public by default."
      />
      <section className="public-runs" aria-label="Browse public runs">
        <div className="public-runs-toolbar">
          <div className="public-runs-field public-runs-search">
            <label htmlFor="public-runs-search">Search public runs</label>
            <input
              id="public-runs-search"
              type="search"
              placeholder="Search by name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="public-runs-field">
            <label htmlFor="public-runs-state">State</label>
            <select
              id="public-runs-state"
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              <option value="">All states</option>
              {states.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          <div className="public-runs-field">
            <label htmlFor="public-runs-started">Started</label>
            <select
              id="public-runs-started"
              value={started}
              onChange={(event) => setStarted(event.target.value)}
            >
              <option value="">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </div>
          {publicRuns.data && (
            <p className="public-runs-count" role="status">
              Showing {matchingRuns?.length} of {publicRuns.data.length} public runs
              {publicRuns.error && " from the last successful load"}
            </p>
          )}
        </div>
        <RunError
          error={publicRuns.error}
          retry={() => void publicRuns.refetch()}
        />
        {publicRuns.isLoading && <p role="status">Loading public runs…</p>}
        {matchingRuns && matchingRuns.length > 0 && (
          <ul className="public-runs-list">
            {matchingRuns.map((run) => (
              <li className="public-runs-item" key={run.id}>
                <Link
                  className="public-runs-name"
                  to={`/run/${encodeURIComponent(run.id)}`}
                  aria-label={`${run.name} (run ${run.id})`}
                >
                  {run.name}
                </Link>
                <div className="public-runs-meta">
                  <span className="public-runs-state">{run.state}</span>
                  <time dateTime={run.started_at}>
                    {startedDate.format(runStartedAt(run.started_at))}
                  </time>
                  <span className="public-runs-id" title={run.id} aria-label={`Run ID ${run.id}`}>
                    {run.id.slice(0, 8)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!publicRuns.error && !publicRuns.isLoading && publicRuns.data?.length === 0 && (
          <p className="public-runs-empty">No public runs yet.</p>
        )}
        {publicRuns.data && publicRuns.data.length > 0 && matchingRuns?.length === 0 && (
          <div className="public-runs-empty">
            <p>No public runs match these filters.</p>
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setState("");
                setStarted("");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </section>
    </>
  );
}
