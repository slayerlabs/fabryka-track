import { useState } from "react";
import { Link } from "react-router";

function CopyCode({ title, text, language }: { title: string; text: string; language: string }) {
  const [status, setStatus] = useState("");
  return <div className="sdk-code"><div className="sdk-code-toolbar"><span>{language}</span><button type="button" aria-label={`Copy ${title}`} onClick={async () => { try { await navigator.clipboard.writeText(text); setStatus("Copied"); } catch { setStatus("Select the code to copy"); } }}>Copy <span aria-hidden="true">⧉</span></button></div><pre aria-label={title} tabIndex={0}><code>{text}</code></pre><span className="sdk-copy-status" role="status" aria-live="polite">{status}</span></div>;
}
export function SDKQuickstart() {
  return <article className="sdk-quickstart" aria-labelledby="sdk-title"><p className="lab-eyebrow">PYTHON SDK</p><h3 id="sdk-title">Track your first run.</h3><p className="sdk-summary">Three steps. Your training stays in your script.</p>
    <ol className="sdk-setup-steps">
      <li><div className="sdk-step-heading"><span aria-hidden="true">1</span><div><h4>Install the SDK</h4><p>Run this in your Python environment.</p></div></div><CopyCode language="TERMINAL" title="SDK installation command" text="pip install fabryka" /></li>
      <li><div className="sdk-step-heading"><span aria-hidden="true">2</span><div><h4>Connect your account</h4><p>Create a key, then set these environment variables.</p></div></div><Link className="sdk-key-button" to="/account">Get my API key <span aria-hidden="true">→</span></Link><CopyCode language="TERMINAL" title="SDK environment configuration" text={'export FABRYKA_API_URL=https://track.fabryka.ai\nexport FABRYKA_API_KEY="YOUR_API_KEY"'} /><p className="sdk-hint">Replace YOUR_API_KEY with your key in your terminal.</p></li>
      <li><div className="sdk-step-heading"><span aria-hidden="true">3</span><div><h4>Log from your training loop</h4><p>Add init and finish around your loop; log the loss at each step.</p></div></div><CopyCode language="PYTHON" title="Python tracking integration" text={'from fabryka import run\n\nrun.init(\n    project="my-project",\n    name="baseline",\n    config={"learning_rate": 3e-4},\n)\n\n# In your training loop, after computing loss:\nrun.log({"train/loss": float(loss)}, step=step)\n\n# After your training loop:\nrun.finish()'} /><p className="sdk-hint">Use the loss and step values from your existing training code.</p></li>
    </ol><div className="sdk-next"><Link to="/runs">View my runs →</Link><a href="https://github.com/slayerlabs/fabryka-track/blob/main/README.sdk.md">Full SDK guide ↗</a></div>
  </article>;
}
