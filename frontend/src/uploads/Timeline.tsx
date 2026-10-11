import { formatBytes } from "./bytes";
import { COPY } from "./copy";
import type { NodeKey, TimelineNode } from "./phases";
import type { UploadProgress } from "./uploader";

const MARKER = { pending: "", active: "", done: "✓", failed: "✕" } as const;

function Transfer({ upload }: { upload: UploadProgress }) {
  const percent = upload.total ? Math.floor((upload.loaded / upload.total) * 100) : 0;
  if (upload.phase === "preparing") return <progress aria-label={COPY.timeline.parts} />;
  return (
    <>
      <progress value={upload.loaded} max={upload.total || 1} aria-label={COPY.timeline[upload.phase === "hashing" ? "hashing" : "parts"]} />
      <span>
        {percent}% · {formatBytes(upload.loaded)} / {formatBytes(upload.total)}
      </span>
    </>
  );
}

interface Props {
  nodes: TimelineNode[];
  upload: UploadProgress | null;
  elapsed: string | null;
}

export function Timeline({ nodes, upload, elapsed }: Props) {
  const detail = (key: NodeKey) => {
    if (upload && key === "hashing" && upload.phase === "hashing") return <Transfer upload={upload} />;
    if (upload && key === "parts" && (upload.phase === "preparing" || upload.phase === "uploading")) return <Transfer upload={upload} />;
    if (key === "running" && elapsed) return <span>{COPY.progress.elapsed}: {elapsed}</span>;
    return null;
  };
  return (
    <ol className="timeline">
      {nodes.map(({ key, state }, index) => (
        <li key={key} className={`timeline-node ${state}`} aria-current={state === "active" ? "step" : undefined}>
          <span className="timeline-marker" aria-hidden="true">
            {state === "pending" ? index + 1 : MARKER[state]}
          </span>
          <div>
            <strong>{COPY.timeline[key]}</strong>
            <span className="timeline-status">{COPY.timelineStatus[state]}</span>
            {state === "active" && <div className="timeline-detail">{detail(key)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
