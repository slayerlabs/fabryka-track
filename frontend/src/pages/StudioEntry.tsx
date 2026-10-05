import { useState } from "react";
import { Link } from "react-router";

type Mode = "beginner" | "advanced" | "agent";
export function StudioEntry({ mode, onChange, disabled }: { mode: Mode; onChange: (mode: Mode) => void; disabled: boolean }) {
  return <div className="studio-entry" role="group" aria-label="Choose how to work">
    {([
      ["beginner", "01", "Beginner", "A guided start", "Choose a profile, build your data mix and review before launching."],
      ["advanced", "02", "Advanced", "Full experiment control", "Exact recipes, Hugging Face imports and training hyperparameters."],
      ["agent", "↗", "Connect my agent", "Work with your own agent", "Give your agent a goal and follow its progress in Track."],
    ] as const).map(([id, number, title, subtitle, body]) => <button key={id} type="button" className={`studio-entry-option ${id === "agent" ? "studio-entry-agent" : ""}`} aria-pressed={mode === id} disabled={disabled} onClick={() => onChange(id)}><span className="eyebrow">{number} · {subtitle}</span><strong>{title}</strong><span>{body}</span><span className="studio-entry-action">{mode === id ? "Selected" : "Choose this path →"}</span></button>)}
  </div>;
}
const instructions = `Connect to Fabryka Track at https://track.fabryka.ai and help me prepare a training experiment.
First read https://track.fabryka.ai/openapi.json for the current API contract.
Ask whether to work in my existing workspace or create an independent agent account.
For my existing workspace, guide me to https://track.fabryka.ai/goals to connect a remote engine and define a goal. Use the scoped engine credential only for the goal-engine protocol.
For an independent workspace, use https://track.fabryka.ai/agents. Registration creates a separate account; it does not grant access to my existing runs or datasets.
Keep credentials in secure local storage, never in chat, logs or source control.
Inspect available datasets and compute, propose the data mix, model and budget, and show me the estimated cost before launching training. Wait for my explicit approval to spend money.
Report progress and link the resulting runs, checkpoints and evaluation evidence in Track.`;
export function StudioAgent() {
  const [status, setStatus] = useState("");
  return <section className="panel studio-agent-panel" aria-labelledby="studio-agent-title">
    <div className="eyebrow">Your agent · your workflow</div><h2 id="studio-agent-title">Connect my agent</h2>
    <p className="muted">Use your own coding or research agent to prepare experiments and report progress. Copy these instructions into your agent to get started.</p>
    <div className="actions"><button className="primary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(instructions); setStatus("Instructions copied. Paste them into your agent."); } catch { setStatus("Select and copy the instructions below."); } }}>Copy instructions for my agent ↗</button><Link className="secondary" to="/goals">Connect to my workspace →</Link></div>
    <p role="status" aria-live="polite">{status}</p>
    <textarea className="studio-agent-instructions" aria-label="Instructions for your agent" readOnly value={instructions} rows={10} />
    <div className="studio-agent-paths"><div><h3>My existing workspace</h3><p>Open Goals, connect a remote engine and give your agent an outcome. Its scoped credential is for the goal-engine protocol.</p><Link to="/goals">Open Goals →</Link></div><div><h3>Independent agent account</h3><p>Create an account with its own API key and private workspace. It has separate runs and datasets from your human account.</p><Link to="/agents">Set up an agent account →</Link></div></div>
    <p className="muted">Connecting requires an agent running on your machine or server. Copying instructions does not start a job or allocate compute.</p>
  </section>;
}
