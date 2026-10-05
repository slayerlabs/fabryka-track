import { useState } from "react";
import { useGetIdentity } from "@refinedev/core";
import { Link } from "react-router";
import type { Identity } from "../provider";
import { useDashboard } from "./DashboardData";
import "../overview.css";

const stages = [
  { name: "Connect", title: "Connect your code or your agent.", body: "Use the Python SDK in your existing training script, call the REST API from your tools, or connect your own agent. Keep execution on your machine or compute provider while Track records the experiment.", evidence: ["Workspace identity", "Run configuration", "Agent or SDK connection"], to: "/account", action: "Set up an SDK API key" },
  { name: "Track", title: "Send progress from where the work runs.", body: "Log metrics, training output and artifacts through the SDK or API. The Python SDK persists events locally and uploads them in the background, so tracking does not block your training loop.", evidence: ["Metrics and logs", "Experiment configuration", "Reported artifacts"], to: "/runs", action: "Inspect tracked runs" },
  { name: "Coordinate", title: "Give your agent a goal and follow its work.", body: "Connect a remote goal engine to your workspace, define an outcome and follow progress updates and linked evidence. An independent agent account has its own workspace; it does not inherit your human account’s data.", evidence: ["Goal and completion criteria", "Agent progress updates", "Linked runs and evidence"], to: "/goals", action: "Connect your own agent" },
  { name: "Review", title: "Use the web workspace to inspect the evidence.", body: "Review curves, logs, checkpoints and recorded evaluations in your browser. Compare experiments under matching conditions, then take the next decision back to your script or agent.", evidence: ["Run comparison", "Checkpoint identity", "Evaluation protocol"], to: "/runs", action: "Review your experiments" },
];

export function OverviewPage({ landing = false }: { landing?: boolean }) {
  const [selected, setSelected] = useState(0);
  const { data: identity } = useGetIdentity<Identity | null>();
  const dashboard = useDashboard(Boolean(identity));
  const stage = stages[selected];
  const gpu = dashboard.data?.gpu_memory;
  const focused = dashboard.data?.runs.filter(run => run.focused) || [];
  return <div className="lab-overview">
    {!landing && <div className="lab-heading"><div><p className="lab-eyebrow">FABRYKA TRACK / API · SDK · AGENTS</p><h1>Track experiments.<br />From your code and agents.</h1><p>An experiment tracking backend for your training scripts, tools and agents. Use the web workspace to monitor progress, inspect evidence and compare results.</p></div><Link className="lab-primary" to="/goals">Connect my agent ↗</Link></div>}
    <section className="lab-integrations" aria-labelledby="integrations-title">
      <div className="lab-section-title"><h2 id="integrations-title">Start from your workflow</h2><a href="/docs">REST API reference ↗</a></div>
      <div className="lab-integration-grid"><article><p className="lab-eyebrow">PYTHON SDK</p><h3>Add tracking to your script.</h3><p>Install the SDK from the repository, set <code>FABRYKA_API_URL=https://track.fabryka.ai</code> and load <code>FABRYKA_API_KEY</code> from your secure environment.</p><pre aria-label="Python SDK tracking example"><code>{`from fabryka_track import run

run.init(project="my-project", name="baseline",
         config={"learning_rate": 3e-4})
# Inside your existing training loop:
run.log({"train/loss": loss}, step=step)
run.finish()`}</code></pre><div><Link to="/account">Get an SDK API key →</Link><a href="https://github.com/slayerlabs/fabryka-track#track-a-run">Install & SDK quickstart ↗</a></div></article>
      <article><p className="lab-eyebrow">REST API & AGENTS</p><h3>Plug Track into your tools.</h3><p>Send events to <code>POST /api/events</code> and query runs through the REST API. Give your own agent a goal, then follow its reports and experiment links in Track.</p><div><Link className="lab-primary" to="/goals">Connect my agent ↗</Link><Link to="/agents">Independent agent account →</Link><a href="/docs">Explore the API ↗</a><a href="/openapi.json">OpenAPI schema ↗</a></div><p className="lab-integration-note">Use Goals for your existing workspace. Agent signup creates a separate workspace. Connecting an agent requires a runtime on your machine or server.</p></article></div>
    </section>
    <section className="lab-cycle" aria-labelledby="cycle-title"><div className="lab-section-title"><h2 id="cycle-title">Code → Track → review</h2><span>How scripts, agents and the browser work together</span></div>
      <div className="lab-steps" role="tablist" aria-label="Research stages">{stages.map((item, index) => <button key={item.name} id={`stage-${index}`} role="tab" aria-selected={selected === index} aria-controls="stage-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => { const target = event.key === "ArrowRight" ? (index + 1) % stages.length : event.key === "ArrowLeft" ? (index + stages.length - 1) % stages.length : event.key === "Home" ? 0 : event.key === "End" ? stages.length - 1 : null; if (target !== null) {event.preventDefault();setSelected(target);document.getElementById(`stage-${target}`)?.focus();} }}><span>0{index + 1}</span>{item.name}<b aria-hidden="true">↗</b></button>)}</div>
      <div className="lab-stage-panel" id="stage-panel" role="tabpanel" aria-labelledby={`stage-${selected}`} tabIndex={0}><div><h3>{stage.title}</h3><p>{stage.body}</p><Link to={stage.to}>{stage.action} →</Link></div><div className="lab-evidence"><span>WHAT STAYS WITH THE EXPERIMENT</span>{stage.evidence.map((item, index) => <div key={item}><span>0{index + 1}</span>{item}</div>)}</div></div>
    </section>
    <section aria-labelledby="activity-title"><div className="lab-section-title"><h2 id="activity-title">Your workspace</h2><Link to="/runs">All focused runs →</Link></div>
      {!identity ? <div className="lab-empty"><h3>Observe your experiments here.</h3><p>Send runs through the SDK or API, then sign in to inspect metrics, saved checkpoints and reported GPU activity.</p><Link className="lab-primary" to="/login">Sign in to Track</Link></div> : dashboard.error ? <div className="lab-empty" role="status"><h3>Workspace data is unavailable.</h3><p>Track will retry automatically. You can still open your runs from the navigation.</p></div> : !dashboard.data ? <p role="status">Loading your workspace…</p> : <><div className="lab-stats"><div><span>Focused runs</span><strong>{focused.length}</strong></div><div><span>Saved checkpoints</span><strong>{dashboard.data.checkpoints.length}</strong></div><div><span>Active GPU runs</span><strong>{gpu?.active_runs ?? "—"}</strong></div><div><span>Reported VRAM</span><strong>{gpu?.used_gb != null && gpu.total_gb != null ? `${gpu.used_gb.toFixed(1)} / ${gpu.total_gb.toFixed(1)} GB` : "Not reported"}</strong></div></div><div className="lab-recent">{focused.length ? focused.slice(0,4).map(run => <Link to={`/run/${encodeURIComponent(run.id)}`} key={run.id}><div><strong>{run.name}</strong><span>{run.project} · {run.checkpoint_count} checkpoints</span></div><span>{run.state} ↗</span></Link>) : <p>No focused runs yet. Connect your script through the SDK or give your agent a goal, then focus a run to follow it here.</p>}</div></>}
    </section>
    <section className="lab-bottom" aria-label="Research practices"><article><p className="lab-eyebrow">COMPUTE WITH CONTEXT</p><h2>Make each run count.</h2><p>Inspect saved checkpoints before scheduling more work. Compare quality alongside reported GPU time and throughput in the run workspace.</p><Link to="/checkpoints">Browse checkpoints →</Link></article><article><p className="lab-eyebrow">EVIDENCE YOU CAN FOLLOW</p><h2>Keep the result and the reason.</h2><p>Use a shared protocol to interpret a score. Review published evaluations and the evidence reported by your code or agent.</p><div><Link to="/benchmark-results">Published results ↗</Link><Link to="/goals">Agent goals ↗</Link></div></article></section>
    <p className="lab-footnote">Prefer a guided browser experiment? <Link to="/new">Open Training studio →</Link> The studio is an optional workflow; use API, SDK and agents for your existing training setup.</p>
  </div>;
}
