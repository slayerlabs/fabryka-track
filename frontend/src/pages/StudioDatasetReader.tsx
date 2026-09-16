import { useEffect, useRef, useState } from "react";
import { corpusSources } from "./StudioData";

export interface Dataset {
  id: string;
  name: string;
  bytes: number;
  example?: boolean;
  category?: string;
  source?: {
    kind?: string;
    repo?: string;
    config?: string;
    split?: string;
    revision?: string;
    sampling?: string;
    [key: string]: unknown;
  };
}
export function StudioDatasetReader({
  dataset,
  onClose,
}: {
  dataset: Dataset;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textView = useRef<HTMLPreElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const found = useRef({ query: "", position: -1 });
  const size = 2000;
  const corpus = corpusSources[dataset.id];
  useEffect(() => {
    const controller = new AbortController();
    const element = dialog.current;
    element?.showModal();
    async function load() {
      try {
        const response = await fetch(
          `/api/datasets/${encodeURIComponent(dataset.id)}/content?preview=true`,
          {
            signal: controller.signal,
            credentials: "same-origin",
            headers: { "X-Track-Request": "1" },
          },
        );
        if (!response.ok) throw new Error("Could not load the dataset text.");
        const content = await response.text();
        if (!controller.signal.aborted) {
          setText(content);
          setLoading(false);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(
            e instanceof Error ? e.message : "Could not load the dataset text.",
          );
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
    };
  }, [dataset.id]);
  useEffect(() => {
    if (textView.current) textView.current.scrollTop = 0;
  }, [offset]);
  function find() {
    const needle = query.toLocaleLowerCase();
    if (!needle) return;
    const previous =
      found.current.query === needle ? found.current.position : -1;
    let next = text.toLocaleLowerCase().indexOf(needle, previous + 1);
    if (next < 0) next = text.toLocaleLowerCase().indexOf(needle);
    found.current = { query: needle, position: next };
    setSearchStatus(
      next < 0 ? "No matches found." : `Match at character ${next + 1}`,
    );
    if (next >= 0) setOffset(Math.max(0, next - 100));
  }
  return (
    <dialog
      ref={dialog}
      className="book-reader"
      aria-labelledby="reader-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="row">
        <h2 id="reader-title">{dataset.name}</h2>
        <button
          className="secondary"
          aria-label="Close preview"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="muted">
        {corpus
          ? `Corpus sample · ${corpus.documents} documents`
          : dataset.example
            ? "Archived test text"
            : "Your private file"}{" "}
        ·{" "}
        {(dataset.bytes / 1e6).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}{" "}
        MB of text
        {dataset.bytes > 2000000 &&
          " · Preview of first 2 MB; navigation and search cover this preview only"}{" "}
        · {text.length.toLocaleString()} characters ·{" "}
        {text.split("\n").length.toLocaleString()} lines
      </p>
      {corpus && (
        <p>
          <a href={corpus.url} target="_blank" rel="noopener noreferrer">
            Source: {corpus.repo} ↗
          </a>
          <br />
          <small>
            Revision {corpus.revision.slice(0, 12)} · {corpus.documents}{" "}
            documents in sample. Initial sample, not the full corpus or a
            representative sample.
          </small>
        </p>
      )}
      {dataset.source?.kind === "huggingface" && (
        <details>
          <summary>Hugging Face source and import filters</summary>
          <p>
            <a
              href={`https://huggingface.co/datasets/${dataset.source.repo}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {dataset.source.repo}
            </a>{" "}
            · {dataset.source.config || "default"}/{dataset.source.split}
            <br />
            Revision {dataset.source.revision}
          </p>
          <p>{dataset.source.sampling}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(dataset.source, null, 2)}
          </pre>
        </details>
      )}
      {loading ? (
        <p role="status">Loading text…</p>
      ) : error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <div className="reader-controls">
            <button className="secondary" onClick={() => setOffset(0)}>
              Beginning
            </button>
            <button
              className="secondary"
              onClick={() =>
                setOffset(Math.max(0, Math.floor(text.length / 2) - size / 2))
              }
            >
              Middle
            </button>
            <button
              className="secondary"
              onClick={() => setOffset(Math.max(0, text.length - size))}
            >
              End
            </button>
            <input
              aria-label="Search dataset text"
              placeholder="Find in this text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  find();
                }
              }}
            />
            <button className="secondary" onClick={find}>
              Find next
            </button>
          </div>
          <small role="status">{searchStatus}</small>
          <pre ref={textView} className="reader-text" id="reader-text">
            {text.slice(offset, offset + size)}
          </pre>
          <div className="row">
            <button
              className="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - size))}
            >
              ← Previous
            </button>
            <span>
              Characters {text.length ? offset + 1 : 0}–
              {Math.min(text.length, offset + size)} of {text.length}
            </span>
            <button
              className="secondary"
              disabled={offset + size >= text.length}
              onClick={() =>
                setOffset(Math.min(text.length - 1, offset + size))
              }
            >
              Next →
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
