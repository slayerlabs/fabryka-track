import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { RunChart } from "./RunChart";
import { RunError, useRunAction, useRunQuery, type Point } from "./RunData";

type NamespaceItem = {
  path: string;
  kind: string;
  artifact_id?: string;
  name?: string;
  value?: unknown;
};
type NamespacePage = {
  items: NamespaceItem[];
  next_cursor?: string;
  config?: unknown;
  hardware?: unknown;
};
type NamespaceNode = {
  children: Map<string, NamespaceNode>;
  item?: NamespaceItem;
};
export function RunNamespace({ id }: { id: string }) {
  const [input, setInput] = useState("");
  const [page, setPage] = useState({ prefix: "", after: "" });
  const [series, setSeries] = useState({ path: "", after: "" });
  const query = useRunQuery<NamespacePage>(
    "/api/runs/" +
      id +
      "/namespace?" +
      new URLSearchParams({ ...page, limit: "100" }),
  );
  const curve = useRunQuery<{ points: Point[]; next_cursor?: string | number }>(
    "/api/runs/" +
      id +
      "/series?" +
      new URLSearchParams({ ...series, limit: "1000" }),
    false,
    !!series.path,
  );
  const tree: NamespaceNode = { children: new Map() };
  for (const item of query.data?.items || []) {
    let node = tree;
    for (const segment of item.path.split("/")) {
      if (!node.children.has(segment))
        node.children.set(segment, { children: new Map() });
      node = node.children.get(segment)!;
    }
    node.item = item;
  }
  function nodes(node: NamespaceNode): ReactNode[] {
    return [...node.children].map(([name, child]) => (
      <div key={name}>
        {child.item && (
          <div className="namespace-leaf">
            <code>{name}</code>
            <span className="muted">{child.item.kind}</span>
            {child.item.kind === "series" ? (
              <button
                onClick={() =>
                  setSeries({ path: child.item!.path, after: "0" })
                }
              >
                Open curve →
              </button>
            ) : child.item.kind === "artifact" ? (
              <RunArtifact
                id={child.item.artifact_id!}
                name={child.item.name || name}
              />
            ) : (
              <code className="namespace-value">
                {JSON.stringify(child.item.value)}
              </code>
            )}
          </div>
        )}
        {child.children.size > 0 && (
          <details className="namespace-folder" open>
            <summary>{name}/</summary>
            <div>{nodes(child)}</div>
          </details>
        )}
      </div>
    ));
  }
  return (
    <>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (page.prefix === input && !page.after) void query.refetch();
          else setPage({ prefix: input, after: "" });
        }}
      >
        <h3>Run namespace</h3>
        <div className="explorer-controls">
          <input
            placeholder="Path prefix, e.g. train/"
            aria-label="Namespace path prefix"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="secondary">Browse</button>
        </div>
      </form>
      <RunError error={query.error} retry={() => void query.refetch()} />
      {query.isLoading && <p role="status">Loading namespace…</p>}
      <div style={{ marginTop: 16 }}>
        {query.data?.config != null && (
          <details>
            <summary>config · initial snapshot</summary>
            <pre>{JSON.stringify(query.data.config, null, 2)}</pre>
          </details>
        )}
        {query.data?.hardware != null && (
          <details>
            <summary>hardware / runtime metadata</summary>
            <pre>{JSON.stringify(query.data.hardware, null, 2)}</pre>
          </details>
        )}
        {nodes(tree)}
        {query.data && !query.data.items.length && (
          <p className="muted">No fields under this prefix.</p>
        )}
      </div>
      {query.data?.next_cursor && (
        <button
          className="secondary"
          onClick={() => setPage({ ...page, after: query.data!.next_cursor! })}
        >
          Next paths →
        </button>
      )}
      <RunError error={curve.error} retry={() => void curve.refetch()} />
      {series.path && curve.isLoading && <p role="status">Loading series…</p>}
      {curve.data && series.path && (
        <div style={{ marginTop: 18 }}>
          <div className="chart">
            <h3>{series.path}</h3>
            <RunChart
              key={series.path + ":" + series.after}
              series={[{ name: series.path, points: curve.data.points }]}
            />
          </div>
          <div className="row">
            <small>
              {curve.data.points.length} recorded points on this page
            </small>
            {curve.data.next_cursor != null &&
              curve.data.next_cursor !== "" && (
                <button
                  className="secondary"
                  onClick={() =>
                    setSeries({
                      ...series,
                      after: String(curve.data!.next_cursor),
                    })
                  }
                >
                  Next points →
                </button>
              )}
          </div>
        </div>
      )}
    </>
  );
}

export function RunArtifact({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<number>());
  useEffect(
    () => () => {
      controller.current?.abort();
      timers.current.forEach(clearTimeout);
      urls.current.forEach(URL.revokeObjectURL);
    },
    [],
  );
  async function download() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/artifacts/" + encodeURIComponent(id), {
        credentials: "same-origin",
        headers: { "X-Track-Request": "1" },
        signal: c.signal,
      });
      if (!response.ok) throw new Error("Download failed. Try again.");
      if (response.headers.get("content-type")?.includes("application/json")) {
        const content: unknown = await response.clone().json();
        if (
          content &&
          typeof content === "object" &&
          "url" in content &&
          typeof content.url === "string"
        ) {
          if (!c.signal.aborted) window.location.assign(content.url);
          return;
        }
      }
      const blob = await response.blob();
      if (c.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        timers.current.delete(timer);
      }, 1000);
      timers.current.add(timer);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void download()}
      >
        ↓ Download {name}
      </button>
      <RunError error={error} />
    </>
  );
}

export type Sample = {
  prompt: string;
  continuation: string;
  checkpoint_step?: number;
  generated_bytes: number;
  elapsed_seconds: number;
  context_bytes: number;
  prompt_truncated?: boolean;
  invalid_utf8: number;
  finish_reason?: string;
};
export function SampleOutput({ sample }: { sample: Sample }) {
  return (
    <>
      {sample.finish_reason === "time_limit" && (
        <p className="notice">
          Generation reached the time limit. The partial continuation is shown
          below. Try fewer output bytes or a shorter prompt.
        </p>
      )}
      <pre
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          padding: 18,
          background: "var(--bg)",
          lineHeight: 1.7,
        }}
      >
        <span className="muted">{sample.prompt}</span>
        <strong>{sample.continuation}</strong>
      </pre>
      <small className="muted">
        Checkpoint step {sample.checkpoint_step ?? "—"} ·{" "}
        {sample.generated_bytes} generated bytes · {sample.elapsed_seconds}s ·
        context {sample.context_bytes} bytes
        {sample.prompt_truncated && " · prompt uses its last context window"}
        {sample.invalid_utf8 > 0 &&
          " · invalid UTF-8 bytes shown as replacement characters"}
      </small>
      <details>
        <summary>Reproduce this sample</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {JSON.stringify(sample, null, 2)}
        </pre>
      </details>
    </>
  );
}
export function RunSampler({
  id,
  onSample,
}: {
  id: string;
  onSample: (sample: Sample) => void;
}) {
  const auth = useRunQuery<{ user: { id: string } | null }>("/api/auth/me");
  const [prompt, setPrompt] = useState("Dawno temu, w małym miasteczku,");
  const [sample, setSample] = useState<Sample>();
  const action = useRunAction();
  return (
    <>
      <h3>Try the saved model</h3>
      <p className="muted">
        Continue a passage of text. This model was trained from scratch on
        next-byte prediction; it is not an instruction-tuned chat model.
      </p>
      <div className="explorer-controls" style={{ margin: "12px 0" }}>
        {[
          ["Polish story", "Dawno temu, w małym miasteczku,"],
          ["English prose", "The purpose of science is to"],
          ["Polish continuation", "Warszawa jest"],
        ].map(([title, text]) => (
          <button
            key={title}
            className="secondary"
            onClick={() => setPrompt(text)}
          >
            {title}
          </button>
        ))}
      </div>
      <RunError error={auth.error} retry={() => void auth.refetch()} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const result = await action.execute<Sample>(
            "/api/runs/" + id + "/generate",
            {
              prompt,
              max_new_bytes: Number(data.get("max_new_bytes")),
              temperature: Number(data.get("temperature")),
              top_k: Number(data.get("top_k")),
              seed: Number(data.get("seed")),
            },
          );
          if (result) {
            setSample(result);
            onSample(result);
          }
        }}
      >
        <fieldset
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          disabled={!auth.data?.user || action.pending}
        >
          <label className="field">
            <span>Prompt</span>
            <textarea
              name="prompt"
              required
              maxLength={2048}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <div className="fields">
            <label className="field">
              <span>New bytes</span>
              <input
                name="max_new_bytes"
                type="number"
                min="1"
                max="512"
                defaultValue="256"
                required
              />
            </label>
            <label className="field">
              <span>Temperature · 0 = greedy</span>
              <input
                name="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                defaultValue="0.8"
                required
              />
            </label>
            <label className="field">
              <span>Top K</span>
              <input
                name="top_k"
                type="number"
                min="1"
                max="256"
                defaultValue="40"
                required
              />
            </label>
            <label className="field">
              <span>Seed</span>
              <input
                name="seed"
                type="number"
                min="0"
                max="2147483647"
                defaultValue="42"
                required
              />
            </label>
          </div>
          <button className="primary">Generate continuation →</button>
        </fieldset>
      </form>
      {auth.data && !auth.data.user && (
        <p>
          <Link className="primary" to="/login">
            Sign in to try this model →
          </Link>
        </p>
      )}
      <div aria-live="polite" style={{ marginTop: 18 }}>
        <RunError error={action.error} />
        {action.pending ? (
          <p>Generating from the saved checkpoint…</p>
        ) : (
          sample && <SampleOutput sample={sample} />
        )}
      </div>
    </>
  );
}
