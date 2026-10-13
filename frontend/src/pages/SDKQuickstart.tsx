import { Link } from "react-router";
import { CodeSnippet } from "./CodeSnippet";

export function SDKQuickstart() {
  return <article className="sdk-quickstart" aria-labelledby="sdk-quickstart"><h2 id="sdk-quickstart" tabIndex={-1}>Track your first run with Python</h2><p className="sdk-summary">Three steps. Your training stays in your script.</p>
    <ol className="sdk-setup-steps">
      <li><div className="sdk-step-heading"><span aria-hidden="true">1</span><div><h4>Install the SDK</h4><p>Run this in your Python environment.</p></div></div><CodeSnippet language="TERMINAL" title="SDK installation command" text="pip install fabryka" /></li>
      <li><div className="sdk-step-heading"><span aria-hidden="true">2</span><div><h4>Connect your account</h4><p>Create a key, then set these environment variables.</p></div></div><p className="sdk-hint">Account API keys grant full access to your account; Track does not enforce per-job spending approval. Keep the key in your trusted environment, not in chat or source control.</p><Link className="sdk-key-button" to="/account">Get my API key <span aria-hidden="true">→</span></Link><CodeSnippet language="TERMINAL" title="SDK environment configuration" text={'export FABRYKA_API_URL=https://track.fabryka.ai\nexport FABRYKA_API_KEY="YOUR_API_KEY"'} /><p className="sdk-hint">Replace YOUR_API_KEY with your key in your terminal.</p></li>
      <li><div className="sdk-step-heading"><span aria-hidden="true">3</span><div><h4>Log from your training loop</h4><p>Add init and finish around your loop; log the loss at each step.</p></div></div><CodeSnippet language="PYTHON" title="Python tracking integration" text={'from fabryka import run\n\nrun.init(\n    project="my-project",\n    name="baseline",\n    config={"learning_rate": 3e-4},\n)\n\n# In your training loop, after computing loss:\nrun.log({"train/loss": float(loss)}, step=step)\n\n# After your training loop:\nrun.finish()'} /><p className="sdk-hint">Use the loss and step values from your existing training code.</p></li>
    </ol><div className="sdk-next"><Link to="/runs">View my runs →</Link><a href="https://github.com/slayerlabs/fabryka-track/blob/main/README.sdk.md" target="_blank" rel="noopener noreferrer">Full SDK reference (opens in a new tab)</a></div>
  </article>;
}
