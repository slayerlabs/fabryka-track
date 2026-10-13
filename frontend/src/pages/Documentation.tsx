import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { PageTop } from "../PageTop";
import { AgentConnection } from "./AgentConnection";
import { SDKQuickstart } from "./SDKQuickstart";
import "../documentation.css";

const sections = [
  ["sdk-quickstart", "Track with Python"],
  ["agent-existing-workspace", "Connect an existing workspace"],
  ["agent-independent-account", "Create a separate agent account"],
  ["training-sandbox", "Training sandbox"],
  ["api-reference", "API reference"],
] as const;

export function DocumentationPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target?.closest(".docs-articles")) target.focus({ preventScroll: true });
  }, [hash]);
  return (
    <>
      <PageTop description="Choose a workflow, then follow the steps. Reading or copying documentation never starts a job." />
      <div className="docs-layout">
        <nav className="docs-contents" aria-label="Documentation sections">
          <h2>On this page</h2>
          <ol>
            {sections.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}
          </ol>
          <p className="docs-contents-reference"><a href="/docs" target="_blank" rel="noopener noreferrer">Open Swagger API reference (opens in a new tab)</a></p>
        </nav>
        <div className="docs-articles">
          <p className="docs-intro">Start with an existing Python script, bring your own agent runtime, or try a guided training run. Each path uses real Track resources, not a simulation.</p>
          <section className="docs-article docs-sdk" aria-labelledby="sdk-quickstart">
            <SDKQuickstart />
          </section>
          <section className="docs-article docs-agent" aria-labelledby="docs-agent-title">
            <AgentConnection />
          </section>
          <section className="docs-article" aria-labelledby="training-sandbox">
            <h2 id="training-sandbox" tabIndex={-1}>Use the training sandbox</h2>
            <p>Choose Beginner for a guided run or Advanced for more control. The sandbox starts real training only after you explicitly launch it.</p>
            <p><Link to="/new">Open the training sandbox</Link> · <Link to="/guide">Understand training and validation</Link></p>
          </section>
          <section className="docs-article" aria-labelledby="api-reference">
            <h2 id="api-reference" tabIndex={-1}>API reference</h2>
            <p>Use the live reference for endpoint shapes and request bodies. The workflow sections above explain when and why to call them.</p>
            <ul className="docs-reference-links">
              <li><a href="/docs" target="_blank" rel="noopener noreferrer">Swagger API reference (opens in a new tab)</a></li>
              <li><a href="/openapi.json" target="_blank" rel="noopener noreferrer">OpenAPI schema (opens in a new tab)</a></li>
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
