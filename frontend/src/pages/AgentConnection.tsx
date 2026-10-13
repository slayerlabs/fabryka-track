import { useState } from "react";
import { Link } from "react-router";
import "../agent-connection.css";

const instructions = `Connect to Fabryka Track at https://track.fabryka.ai and help me prepare a training experiment.
First read https://track.fabryka.ai/openapi.json for the current API contract and https://github.com/slayerlabs/fabryka-track/blob/main/docs/goal-engine.md for manual goal-engine setup.
Ask whether to work in my existing workspace or create an independent agent account.
For my existing workspace, guide me through the authenticated POST /api/goal-engine/connect call. Its credential is shown once and authorizes only the goal-engine claim/progress protocol. I must store it in the runtime's secure local storage; do not ask for my browser session or paste credentials into chat.
Before I approve an objective, warn me that POST /api/goals creates a public tracking run whose name contains the first 180 characters of the objective. Do not include secrets or sensitive plans in it. Then guide me to submit it through the authenticated POST /api/goals call.
Training and uploads require a separate API key from my existing Track account. That key has full account access, not just training permission. Never request it in chat or give it to an untrusted agent; only a trusted operator-controlled runtime should hold it.
For an independent workspace, use https://track.fabryka.ai/agents. Registration creates a separate account; it does not grant access to my existing runs or datasets.
Keep credentials out of chat, logs, source control and goal text. The agent runtime runs on my machine or server; copying these instructions does not connect it or start a job.
Inspect available datasets and compute, propose the data mix, model and budget, and ask for explicit cost approval before launching training. Track does not enforce per-job spending approval for account API keys; the operator must control launches and credentials outside this prompt.
Report progress and link the resulting runs, checkpoints and evaluation evidence in Track.`;

export function AgentConnection() {
  const [status, setStatus] = useState("");
  return <section className="agent-connection" aria-labelledby="docs-agent-title">
    <h2 id="docs-agent-title" tabIndex={-1}>Connect your own agent</h2>
    <p>Copy these instructions into your own coding or research agent. Connecting a goal engine to this workspace requires manual API setup and a runtime on your machine or server.</p>
    <div className="cockpit-agent-paths"><div><h3 id="agent-existing-workspace" tabIndex={-1}>My existing workspace</h3><p>Follow the manual goal-engine guide to issue a scoped credential and run your own adapter. Training and uploads need a full-access account API key; keep it in a trusted runtime, not an agent chat. Goal submissions expose the first 180 characters of the objective in a public run name.</p><a href="https://github.com/slayerlabs/fabryka-track/blob/main/docs/goal-engine.md" target="_blank" rel="noopener noreferrer">Manual goal-engine setup (opens in a new tab)</a></div><div><h3 id="agent-independent-account" tabIndex={-1}>Independent agent account</h3><p>Create an account with its own API key and private workspace. It has separate runs and datasets from your human account.</p><Link to="/agents">Set up an agent account →</Link></div></div>
    <div className="actions"><button className="primary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(instructions); setStatus("Instructions copied. Paste them into your agent."); } catch { setStatus("Select and copy the instructions below."); } }}>Copy instructions for my agent ↗</button></div>
    <p role="status" aria-live="polite">{status}</p>
    <textarea className="cockpit-agent-instructions" aria-label="Instructions for your agent" readOnly value={instructions} rows={10} />
    <p className="muted">Connecting requires an agent running on your machine or server. Copying instructions does not start a job or allocate compute.</p>
  </section>;
}
