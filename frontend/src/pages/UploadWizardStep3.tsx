import { useContext, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { browserUploaderDeps, cancelUpload, getUpload, type UploadJob } from "../uploads/api.ts";
import {
  describeJob,
  failureHint,
  keepPolling,
  rejectionMessage,
  stoppedMessage,
} from "../uploads/display.ts";
import { uploadFile, type UploadProgress } from "../uploads/uploader.ts";
import { validateUpload, type UploadFormState } from "../uploads/form.ts";
import type { MetadataValues } from "../uploads/metadata.tsx";
import { WizardDraftContext } from "./UploadWizard.tsx";

const POLL_MS = 5000;

const PROGRESS_LABELS: Record<UploadProgress["phase"], string> = {
  hashing: "Checking file",
  preparing: "Preparing upload",
  uploading: "Uploading parts",
  confirming: "Confirming upload",
};

const NODES = ["Upload", "Validate", "Queue", "Run", "Results"] as const;

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function nodeIndex(job: UploadJob | null, progress: UploadProgress | null): number {
  if (!job) {
    if (!progress) return 0;
    return progress.phase === "confirming" ? 1 : 0;
  }
  switch (job.client_phase) {
    case "uploading":
      return 0;
    case "validating":
      return 1;
    case "queued":
      return 2;
    case "running":
    case "finalizing":
      return 3;
    default:
      return 4;
  }
}

function Timeline({ index, terminal }: { index: number; terminal: boolean }) {
  return (
    <ol>
      {NODES.map((label, position) => (
        <li
          key={label}
          aria-current={!terminal && position === index ? "step" : undefined}
        >
          {label}
          {terminal || position < index ? " ✓" : position === index ? " — now" : ""}
        </li>
      ))}
    </ol>
  );
}

export function StepRun({ pipeline, jobId }: { pipeline: string; jobId: string | null }) {
  const draft = useContext(WizardDraftContext);
  const navigate = useNavigate();
  const [job, setJob] = useState<UploadJob | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const lastPhase = useRef<UploadProgress["phase"]>("hashing");
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);
  const wasLive = useRef(false);
  const advanced = useRef(false);
  useEffect(() => () => abort.current?.abort(), []);

  const described = job && describeJob(job);
  const index = nodeIndex(job, progress);
  const busy = progress !== null || (job !== null && !described?.terminal);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  if (!draft) throw new Error("StepRun must render inside the wizard draft provider.");
  const { file, ...meta }: { file: File | null } & MetadataValues = {
    file: draft.draft.file,
    source: draft.draft.source,
    added: draft.draft.added,
    license: draft.draft.license,
    author: draft.draft.author,
    source_ref: draft.draft.source_ref,
    per_record_provenance: draft.draft.per_record_provenance,
    mask_names: draft.draft.mask_names,
    declaration: draft.draft.declaration,
  };
  const formState: UploadFormState = { pipeline, file, ...meta };
  const checked = validateUpload(formState);
  const gated = !file || Object.keys(checked.errors).length > 0;

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await getUpload(jobId as string, controller.signal);
        setJob(next);
        setError("");
        const described = describeJob(next);
        if (!described.terminal) wasLive.current = true;
        if (described.terminal && wasLive.current && !advanced.current) {
          advanced.current = true;
          navigate(
            `/uploads/new?step=4&job=${encodeURIComponent(next.job_id)}&pipeline=${encodeURIComponent(pipeline)}`,
          );
        }
        if (described.terminal) return;
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(message(e));
        if (!keepPolling(e)) return;
      }
      timer = setTimeout(refresh, POLL_MS);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId, navigate, pipeline]);

  async function start() {
    if (!checked.form || !file || started.current) return;
    started.current = true;
    const controller = new AbortController();
    abort.current = controller;
    setError("");
    lastPhase.current = "hashing";
    setProgress({ phase: "hashing", loaded: 0, total: file.size });
    try {
      const id = await uploadFile(file, checked.form, browserUploaderDeps(), {
        signal: controller.signal,
        onProgress: (next) => {
          lastPhase.current = next.phase;
          setProgress(next);
        },
      });
      setProgress(null);
      navigate(`/uploads/new?step=3&job=${encodeURIComponent(id)}&pipeline=${encodeURIComponent(pipeline)}`, {
        replace: true,
      });
    } catch (e) {
      setError(controller.signal.aborted ? stoppedMessage(lastPhase.current) : message(e));
      setProgress(null);
      started.current = false;
    }
  }

  async function cancel() {
    if (!job || !window.confirm("Cancel this upload? This cannot be undone.")) return;
    setCancelling(true);
    try {
      setJob(await cancelUpload(job.job_id));
    } catch (e) {
      setError(message(e));
    } finally {
      setCancelling(false);
    }
  }

  if (gated && !jobId) {
    return (
      <section className="panel">
        <h2>Step 3: run the pipeline</h2>
        <p className="muted">Choose a file and fill the parameters in step 2 first.</p>
        <div className="actions">
          <Link className="secondary" to={`/uploads/new?step=2&pipeline=${encodeURIComponent(pipeline)}`}>
            Back to step 2
          </Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Step 3: run the pipeline</h2>
        {!jobId && !job && (
          <>
            <p className="muted">
              {file?.name} · {pipeline}. Starting the upload hands the file to the existing pipeline flow;
              keep this tab open until the upload finishes.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button className="primary" type="button" disabled={progress !== null} onClick={() => void start()}>
                {progress ? "Starting…" : "Start upload"}
              </button>
              {progress && progress.phase !== "confirming" && (
                <button className="secondary" type="button" onClick={() => abort.current?.abort()}>
                  Stop upload
                </button>
              )}
            </div>
          </>
        )}
        <Timeline index={index} terminal={described?.terminal ?? false} />
        {progress && (
          <p className="notice" role="status">
            {PROGRESS_LABELS[progress.phase]} ·{" "}
            {progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0}%
          </p>
        )}
        {job && described && (
          <>
            <p className="muted">
              Phase: {described.phase} · Outcome: {described.outcome}
            </p>
            {failureHint(job) && (
              <p className="notice" role="status">
                {failureHint(job)}
              </p>
            )}
            {rejectionMessage(job) && (
              <p className="notice" role="status">
                {rejectionMessage(job)}
              </p>
            )}
            {!described.terminal && (
              <div className="actions">
                <button className="secondary" type="button" disabled={cancelling} onClick={() => void cancel()}>
                  {cancelling ? "Cancelling…" : "Cancel upload"}
                </button>
              </div>
            )}
            {described.terminal && (
              <div className="actions">
                <Link
                  className="primary"
                  to={`/uploads/new?step=4&job=${encodeURIComponent(job.job_id)}&pipeline=${encodeURIComponent(pipeline)}`}
                >
                  Continue to results
                </Link>
              </div>
            )}
          </>
        )}
      </section>
      {busy && (
        <p className="muted" role="status">
          Working… polling every {POLL_MS / 1000} seconds.
        </p>
      )}
    </>
  );
}
