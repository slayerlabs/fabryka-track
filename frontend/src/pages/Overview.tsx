import { useGetIdentity } from "@refinedev/core";
import { Link } from "react-router";
import { PageTop } from "../PageTop";
import type { Identity } from "../provider";
import { useDashboard } from "./DashboardData";
import "../overview.css";

export function OverviewPage({ landing = false }: { landing?: boolean }) {
  const identityQuery = useGetIdentity<Identity | null>();
  const identity = identityQuery.data;
  const dashboard = useDashboard(Boolean(identity));
  const gpu = dashboard.data?.gpu_memory;
  const focused = dashboard.data?.runs.filter((run) => run.focused) || [];

  return (
    <>
      {!landing && (
        <PageTop description="Inspect your runs, checkpoints and reported compute. Choose a setup path below when you are ready to connect." />
      )}
      <div className={`lab-overview${landing ? " lab-overview-landing" : ""}`}>
        <section className="lab-workspace" aria-labelledby="activity-title">
          <div className="lab-section-title">
            <h2 id="activity-title">Your workspace</h2>
            {identity && <Link to="/runs">All focused runs →</Link>}
          </div>
          {identityQuery.isLoading ? (
            <p role="status">Checking your session…</p>
          ) : identityQuery.isError ? (
            <div className="lab-empty" role="status">
              <h3>We could not check your session.</h3>
              <p>Your workspace status is unknown. Retry before signing in or viewing your runs.</p>
              <button className="lab-primary" type="button" onClick={() => void identityQuery.refetch()}>Retry session check</button>
            </div>
          ) : !identity ? (
            <div className="lab-empty">
              <h3>Your runs and checkpoints are private.</h3>
              <p>Sign in to view your workspace, or explore public runs while you decide how to connect.</p>
              <div className="lab-empty-actions">
                <Link className="lab-primary" to="/login">Sign in to Track</Link>
                <Link to="/public-runs">Browse public runs →</Link>
              </div>
            </div>
          ) : dashboard.error ? (
            <div className="lab-empty" role="status">
              <h3>Workspace data is unavailable.</h3>
              <p>Track will retry automatically. You can still open your runs.</p>
              <Link to="/runs">Open focused runs →</Link>
            </div>
          ) : !dashboard.data ? (
            <p role="status">Loading your workspace…</p>
          ) : (
            <>
              <div className="lab-stats">
                <div><span>Focused runs</span><strong>{focused.length}</strong></div>
                <div><span>Saved checkpoints</span><strong>{dashboard.data.checkpoints.length}</strong></div>
                <div><span>Active GPU runs</span><strong>{gpu?.active_runs ?? "—"}</strong></div>
                <div><span>Reported VRAM</span><strong>{gpu?.used_gb != null && gpu.total_gb != null ? `${gpu.used_gb.toFixed(1)} / ${gpu.total_gb.toFixed(1)} GB` : "Not reported"}</strong></div>
              </div>
              <div className="lab-recent">
                {focused.length ? focused.slice(0, 4).map((run) => (
                  <Link to={`/run/${encodeURIComponent(run.id)}`} key={run.id}>
                    <div><strong>{run.name}</strong><span>{run.project} · {run.checkpoint_count} checkpoints</span></div>
                    <span>{run.state} ↗</span>
                  </Link>
                )) : (
                  <p>No focused runs yet. Track an existing script with Python or browse your runs to focus one. <a href="/api-docs#sdk-quickstart" target="_blank" rel="noopener noreferrer">See Python setup (opens in a new tab)</a></p>
                )}
              </div>
            </>
          )}
        </section>

        <section className="lab-integrations" aria-labelledby="integrations-title">
          <div className="lab-section-title"><h2 id="integrations-title">Connect your tools</h2></div>
          <p>Start with your Python script or bring your own agent runtime. Reading the setup steps does not start a job.</p>
          <div className="lab-paths">
            <article>
              <h3>Track with Python</h3>
              <p>Install the SDK and log an existing run from your training script.</p>
              <a href="/api-docs#sdk-quickstart" target="_blank" rel="noopener noreferrer">See Python setup (opens in a new tab)</a>
            </article>
            <article>
              <h3>Connect your own agent</h3>
              <p>Choose an existing workspace or a separate account. Your runtime stays under your control; setup does not allocate compute.</p>
              <div className="lab-path-links">
                <a href="/api-docs#agent-existing-workspace" target="_blank" rel="noopener noreferrer">Existing workspace setup (opens in a new tab)</a>
                <a href="/api-docs#agent-independent-account" target="_blank" rel="noopener noreferrer">Separate account setup (opens in a new tab)</a>
              </div>
            </article>
          </div>
        </section>

        <section className="lab-resources" aria-labelledby="resources-title">
          <div className="lab-section-title"><h2 id="resources-title">Explore further</h2></div>
          <nav aria-label="Cockpit resources">
            <ul className="lab-resource-links">
              <li><Link to="/checkpoints">Checkpoints →</Link></li>
              <li><Link to="/benchmark-results">Published results →</Link></li>
              <li><Link to="/goals">Current Lab Goals →</Link></li>
              <li><a href="/docs" target="_blank" rel="noopener noreferrer">Swagger API reference (opens in a new tab)</a></li>
              <li><a href="/openapi.json" target="_blank" rel="noopener noreferrer">OpenAPI schema (opens in a new tab)</a></li>
              <li><Link to="/new">Training sandbox →</Link></li>
            </ul>
          </nav>
          <p className="lab-footnote">Training sandbox is a guided browser workflow for real runs. Nothing launches until you explicitly start it.</p>
        </section>
      </div>
    </>
  );
}
