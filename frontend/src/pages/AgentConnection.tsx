import { Link } from "react-router";
import { CodeSnippet } from "./CodeSnippet";
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

const independentInstructions = `Connect my independent agent account to Fabryka Track at https://track.fabryka.ai and help me prepare a training experiment.
Read https://track.fabryka.ai/openapi.json for the current API contract. This account has its own private workspace and cannot access my human account's runs or datasets.
I will put its API key in a trusted runtime on my machine or server. The key grants full account access, including training and uploads. Never request it in chat or put it in logs, source control or goal text.
Inspect available datasets and compute, propose the data mix, model and budget, and ask for explicit cost approval before launching training. Track does not enforce per-job spending approval for account API keys; the operator must control launches and credentials outside this prompt.
Report progress and link the resulting runs, checkpoints and evaluation evidence in Track. Copying these instructions does not connect the runtime or start a job.`;

const beforeRegistrationInstructions = `Help me prepare an independent agent account for Fabryka Track at https://track.fabryka.ai.
Read https://track.fabryka.ai/openapi.json for the current API contract. I will create the account at https://track.fabryka.ai/agents; it will have its own private workspace and no access to my human account's runs or datasets.
Once registered, I will save its API key in a trusted runtime on my machine or server. The key grants full account access, including training and uploads. Never request it in chat or put it in logs, source control or goal text.
Inspect available datasets and compute, propose the data mix, model and budget, and ask for explicit cost approval before launching training. Track does not enforce per-job spending approval for account API keys; the operator must control launches and credentials outside this prompt.
Report progress and link the resulting runs, checkpoints and evaluation evidence in Track. Copying these instructions does not register an account, connect the runtime or start a job.`;

export function AgentConnection({ independentOnly = false, registered = false }: { independentOnly?: boolean; registered?: boolean }) {
  return <section className="agent-connection" aria-labelledby="docs-agent-title">
    <h2 id="docs-agent-title" tabIndex={-1}>Connect your own agent</h2>
    {independentOnly
      ? registered
        ? <p>Save your new account key in a trusted runtime, then copy these instructions into your coding or research agent. This account is separate from your human workspace.</p>
        : <p>Create a separate agent account on this page first. Its key is shown once; save it in a trusted runtime, not in chat. These instructions help your agent prepare for that independent workspace.</p>
      : <p>Choose where your agent will work, then copy the instructions into your coding or research agent. Connecting a goal engine to this workspace requires manual API setup and a runtime on your machine or server.</p>}
    <ul className="agent-connection-paths">
      {!independentOnly && <li>
        <h3 id="agent-existing-workspace" tabIndex={-1}>My existing workspace</h3>
        <p>Follow the manual goal-engine guide to issue a scoped credential and run your own adapter. Training and uploads need a full-access account API key; keep it in a trusted runtime, not an agent chat. Goal submissions expose the first 180 characters of the objective in a public run name.</p>
        <a href="https://github.com/slayerlabs/fabryka-track/blob/main/docs/goal-engine.md" target="_blank" rel="noopener noreferrer">Manual goal-engine setup (opens in a new tab)</a>
      </li>}
      <li>
        <h3 id="agent-independent-account" tabIndex={-1}>Independent agent account</h3>
        <p>{registered ? "Your agent has its own API key and private workspace. Its runs and datasets are separate from your human account." : "Create an account with its own API key and private workspace. It has separate runs and datasets from your human account."}</p>
        {!independentOnly && <Link to="/agents">Set up an agent account →</Link>}
      </li>
    </ul>
    <h3 className="agent-connection-instructions-heading">Instructions for your agent</h3>
    <CodeSnippet language="AGENT INSTRUCTIONS" title="instructions for your agent" text={independentOnly ? (registered ? independentInstructions : beforeRegistrationInstructions) : instructions} />
    <p className="agent-connection-hint">Connecting requires an agent running on your machine or server. Copying instructions does not start a job or allocate compute.</p>
    {independentOnly && <p className="agent-connection-hint"><Link to="/api-docs#docs-agent-title">Read the full agent guide</Link> for the existing-workspace path.</p>}
  </section>;
}
