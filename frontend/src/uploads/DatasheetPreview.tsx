import { useEffect, useMemo, useState } from "react";
import { datasheetText } from "./api";
import { COPY } from "./copy";
import { parseDatasheet, type Block, type Inline } from "./datasheet";
import { errorMessage } from "./display";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "done"; markdown: string };

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "strong" ? <strong key={index}>{part.text}</strong> : part.kind === "code" ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

function Render({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const Tag = (["h3", "h4", "h5", "h6"] as const)[block.level - 1];
      return <Tag><Text parts={block.inlines} /></Tag>;
    }
    case "paragraph":
      return <p><Text parts={block.inlines} /></p>;
    case "list":
      return <ul>{block.items.map((item, index) => <li key={index}><Text parts={item} /></li>)}</ul>;
    case "code":
      return <pre>{block.text}</pre>;
    case "table":
      return (
        <div className="table-scroll">
          <table>
            <thead><tr>{block.header.map((cell, index) => <th key={index}><Text parts={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}><Text parts={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

export function DatasheetPreview({ jobId, diagnostic }: { jobId: string; diagnostic: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [tab, setTab] = useState<"preview" | "markdown">("preview");
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    datasheetText(jobId, diagnostic, controller.signal).then(
      ({ markdown }) => !controller.signal.aborted && setLoad({ status: "done", markdown }),
      (e) => !controller.signal.aborted && setLoad({ status: "error", message: errorMessage(e) }),
    );
    return () => controller.abort();
  }, [jobId, diagnostic]);
  const parsed = useMemo(() => (load.status === "done" ? parseDatasheet(load.markdown) : null), [load]);
  if (load.status === "loading") return <p className="muted">{COPY.results.datasheetLoading}</p>;
  if (load.status === "error") return <p className="error" role="alert">{load.message}</p>;
  return (
    <>
      <div className="tabs" role="tablist">
        {(["preview", "markdown"] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : undefined} onClick={() => setTab(key)}>
            {COPY.results[key]}
          </button>
        ))}
      </div>
      {tab === "markdown" ? (
        <pre className="datasheet-raw">{load.markdown}</pre>
      ) : (
        <div className="datasheet">
          {parsed && parsed.front.length > 0 && (
            <table>
              <tbody>
                {parsed.front.map(([key, value]) => (
                  <tr key={key}><th>{COPY.results.front[key as keyof typeof COPY.results.front] ?? key}</th><td>{value}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {parsed?.blocks.map((block, index) => <Render key={index} block={block} />)}
        </div>
      )}
    </>
  );
}
