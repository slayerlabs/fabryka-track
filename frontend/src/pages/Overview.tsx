import { useState } from "react";
import { useGetIdentity } from "@refinedev/core";
import { Link } from "react-router";
import type { Identity } from "../provider";
import { useDashboard } from "./DashboardData";
import "../overview.css";

const stages = [
  { name: "Prepare data", title: "Start with what your model will learn.", body: "Choose your text sources and set their proportions in Training studio. Keep the dataset mix with the recipe so the next experiment has a clear starting point.", evidence: ["Dataset sources", "Mixture proportions", "Training recipe"], to: "/new", action: "Open Training studio" },
  { name: "Train", title: "Follow the experiment as it happens.", body: "Watch training and validation metrics, read logs, and keep checkpoints. Group related runs so you can follow an idea from its baseline to its next version.", evidence: ["Run configuration", "Metrics and logs", "Saved checkpoints"], to: "/runs", action: "Explore focused runs" },
  { name: "Evaluate", title: "Find out what a checkpoint can do.", body: "Choose a saved checkpoint and evaluate it against a defined protocol. Smoke checks, validation and final tests stay distinct, so a quick check is never mistaken for a full result.", evidence: ["Checkpoint identity", "Dataset and split", "Evaluation protocol"], to: "/checkpoints", action: "Choose a checkpoint" },
  { name: "Compare & learn", title: "Give the next experiment a better starting point.", body: "Compare runs with matching evaluation conditions. Keep the result alongside the recipe and checkpoint, then review a fork in Training studio before starting new work.", evidence: ["Run comparison", "Recorded results", "Reviewed next experiment"], to: "/runs", action: "Compare your runs" },
];

export function OverviewPage({ landing = false }: { landing?: boolean }) {
  const [selected, setSelected] = useState(0);
  const { data: identity } = useGetIdentity<Identity | null>();
  const dashboard = useDashboard(Boolean(identity));
  const stage = stages[selected];
  const gpu = dashboard.data?.gpu_memory;
  const focused = dashboard.data?.runs.filter(run => run.focused) || [];
  return <div className="lab-overview">
    {!landing && <div className="lab-heading"><div><p className="lab-eyebrow">FABRYKA TRACK / RESEARCH WORKSPACE</p><h1>From a training idea<br />to an evaluated model.</h1><p>Data, experiments, checkpoints and results — connected in one workspace.</p></div><Link className="lab-primary" to="/new">Open Training studio ↗</Link></div>}
    <section className="lab-cycle" aria-labelledby="cycle-title"><div className="lab-section-title"><h2 id="cycle-title">Your research cycle</h2><span>Choose a step to see the workflow</span></div>
      <div className="lab-steps" role="tablist" aria-label="Research stages">{stages.map((item, index) => <button key={item.name} id={`stage-${index}`} role="tab" aria-selected={selected === index} aria-controls="stage-panel" tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => { const target = event.key === "ArrowRight" ? (index + 1) % stages.length : event.key === "ArrowLeft" ? (index + stages.length - 1) % stages.length : event.key === "Home" ? 0 : event.key === "End" ? stages.length - 1 : null; if (target !== null) {event.preventDefault();setSelected(target);document.getElementById(`stage-${target}`)?.focus();} }}><span>0{index + 1}</span>{item.name}<b aria-hidden="true">↗</b></button>)}</div>
      <div className="lab-stage-panel" id="stage-panel" role="tabpanel" aria-labelledby={`stage-${selected}`} tabIndex={0}><div><h3>{stage.title}</h3><p>{stage.body}</p><Link to={stage.to}>{stage.action} →</Link></div><div className="lab-evidence"><span>WHAT STAYS WITH THE EXPERIMENT</span>{stage.evidence.map((item, index) => <div key={item}><span>0{index + 1}</span>{item}</div>)}</div></div>
    </section>
    <section aria-labelledby="activity-title"><div className="lab-section-title"><h2 id="activity-title">Your workspace</h2><Link to="/runs">All focused runs →</Link></div>
      {!identity ? <div className="lab-empty"><h3>Bring your next experiment.</h3><p>Sign in to see your runs, saved checkpoints and reported GPU activity.</p><Link className="lab-primary" to="/login">Sign in to Track</Link></div> : dashboard.error ? <div className="lab-empty" role="status"><h3>Workspace data is unavailable.</h3><p>Track will retry automatically. You can still open your runs from the navigation.</p></div> : !dashboard.data ? <p role="status">Loading your workspace…</p> : <><div className="lab-stats"><div><span>Focused runs</span><strong>{focused.length}</strong></div><div><span>Saved checkpoints</span><strong>{dashboard.data.checkpoints.length}</strong></div><div><span>Active GPU runs</span><strong>{gpu?.active_runs ?? "—"}</strong></div><div><span>Reported VRAM</span><strong>{gpu?.used_gb != null && gpu.total_gb != null ? `${gpu.used_gb.toFixed(1)} / ${gpu.total_gb.toFixed(1)} GB` : "Not reported"}</strong></div></div><div className="lab-recent">{focused.length ? focused.slice(0,4).map(run => <Link to={`/run/${encodeURIComponent(run.id)}`} key={run.id}><div><strong>{run.name}</strong><span>{run.project} · {run.checkpoint_count} checkpoints</span></div><span>{run.state} ↗</span></Link>) : <p>No focused runs yet. Start by reviewing a dataset mix and training recipe.</p>}</div></>}
    </section>
    <section className="lab-bottom" aria-label="Research practices"><article><p className="lab-eyebrow">COMPUTE WITH CONTEXT</p><h2>Make each run count.</h2><p>Inspect saved checkpoints before scheduling more work. Compare quality alongside reported GPU time and throughput in the run workspace.</p><Link to="/checkpoints">Browse checkpoints →</Link></article><article><p className="lab-eyebrow">EVIDENCE YOU CAN FOLLOW</p><h2>Keep the result and the reason.</h2><p>Use a shared protocol to interpret a score. Explore published evaluations, read the research goals, or connect an agent to Track.</p><div><Link to="/benchmark-results">Published results ↗</Link><Link to="/agents">Connect an agent ↗</Link></div></article></section>
    <p className="lab-footnote">Opening this workspace or exploring a step does not start a training or evaluation job.</p>
  </div>;
}
