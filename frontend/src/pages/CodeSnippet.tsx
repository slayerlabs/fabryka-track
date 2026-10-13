import { useState } from "react";
import "../code-snippet.css";

export function CodeSnippet({ title, text, language }: { title: string; text: string; language: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="code-snippet">
      <div className="code-snippet-toolbar">
        <span>{language}</span>
        <button type="button" aria-label={`Copy ${title}`} onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("Copied");
          } catch {
            setStatus("Select the code to copy");
          }
        }}>Copy <span aria-hidden="true">⧉</span></button>
      </div>
      <pre aria-label={title} tabIndex={0}><code>{text}</code></pre>
      <span className="code-snippet-status" role="status" aria-live="polite">{status}</span>
    </div>
  );
}
