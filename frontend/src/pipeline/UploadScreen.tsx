import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { decode } from "./contract.ts";
import { ApiError, PipelineApi } from "./api.ts";
import { errorText, pollJob, terminalView } from "./state.ts";
import { assertSameInput, createBody, detectFormat, newOperationKey, sha256File, uploadParts }
  from "./transfer.ts";
import type { ConfirmUpload, CreateUpload, FileMetadata, JobReport, JobStatus, UploadSession } from "./types.ts";

type Step = "create" | "transfer" | "confirm" | "poll" | "cancel";
type Keys = { create: string; confirm: string; cancel: string };
type Operation = {
  file: File | null;
  sha: string;
  size: number;
  body: CreateUpload | null;
  keys: Keys;
  session: UploadSession | null;
  completed: ConfirmUpload["parts"];
  confirm: ConfirmUpload | null;
  failed: Step | null;
};
type Progress = { label: string; value: number; max: number };

const api = new PipelineApi();
const STORE_KEY = "pipeline-upload-operation";
const KEY = /^[\x21-\x7e]{16,128}$/;
const SETTLED_PHASES = new Set<JobStatus["client_phase"]>(["complete", "expired", "rejected"]);
const VERDICTS = new Set<JobStatus["processing_state"]>(["passed", "failed_qa", "failed", "cancelled", "rejected"]);

const processingLabels: Record<JobStatus["processing_state"], string> = {
  uploading: "Waiting for upload",
  validating: "Validating input",
  queued: "Queued",
  provisioning: "Starting worker",
  running: "Running",
  passed: "Passed",
  failed_qa: "QA failed",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Rejected",
};
const publicationLabels: Record<JobStatus["publication_state"], string> = {
  none: "Not published",
  pending: "Pending",
  published: "Published",
  expired: "Expired",
};
const cleanupLabels: Record<JobStatus["cleanup_state"], string> = {
  not_due: "Not due",
  pending: "Pending",
  confirmed: "Confirmed",
};
const failureLabels: Record<NonNullable<JobStatus["failure_code"]>, string> = {
  empty_result: "Curation left no records",
  qa_failed: "One or more QA checks failed",
  metadata_conflict: "Records conflict with the provided metadata",
  provider_transient: "A temporary infrastructure failure ended the job",
  lease_lost: "A temporary infrastructure failure ended the job",
  transfer_transient: "A temporary infrastructure failure ended the job",
  runtime_unsupported: "The processing runtime is not supported",
  input_corrupt: "The input is corrupt or does not match the declared file",
  memory_limit: "The job exceeded its memory limit",
  scratch_limit: "The job exceeded its disk limit",
  deadline: "The job ran past its deadline",
  recipe_failed: "Processing failed",
};

const today = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
const when = (value: string | number) =>
  new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
const settled = (status: JobStatus | null) => !!status && SETTLED_PHASES.has(status.client_phase);

function save(op: Operation) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ sha: op.sha, size: op.size, keys: op.keys,
      session: op.session }));
  } catch {
    // Storage may be unavailable; the job still runs, only reload recovery is lost.
  }
}

function restore(): Operation | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null");
    if (!saved) return null;
    const session = decode<UploadSession>("UploadSession", saved.session);
    const keys = saved.keys as Keys;
    if (![keys.create, keys.confirm, keys.cancel].every((key) => KEY.test(key))) return null;
    if (session.input_sha256 !== saved.sha || session.encoded_bytes !== saved.size) return null;
    return { file: null, sha: saved.sha, size: saved.size, body: null, keys, session, completed: [],
      confirm: null, failed: "transfer" };
  } catch {
    return null;
  }
}

export function UploadScreen() {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [added, setAdded] = useState(today);
  const [license, setLicense] = useState("");
  const [author, setAuthor] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [perRecord, setPerRecord] = useState(false);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [report, setReport] = useState<JobReport | null>(null);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [needsFile, setNeedsFile] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const opRef = useRef<Operation | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const view = status ? terminalView(status) : null;
  const done = settled(status);
  const jobActive = !!opRef.current?.session && !done;

  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done, view?.title]);

  useEffect(() => {
    if (paused) retryRef.current?.focus();
  }, [paused]);

  useEffect(() => {
    const op = restore();
    if (!op) return;
    opRef.current = op;
    void recover(op);
    return () => abortRef.current?.abort();
  }, []);

  function show(next: JobStatus) {
    setStatus(next);
    setUpdatedAt(api.now());
  }

  function begin(): AbortController {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setPaused(false);
    return controller;
  }

  async function recover(op: Operation) {
    const controller = begin();
    try {
      const current = await api.status(op.session!.job_id, controller.signal);
      show(current);
      if (current.processing_state === "uploading" && !settled(current)) {
        setNeedsFile(true);
        setMessage("An unfinished upload was found. Select the original file to resume it before "
          + when(current.upload_deadline) + ".");
        setBusy(false);
        return;
      }
      if (!settled(current)) await run("poll", controller);
      else setBusy(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      op.failed = "poll";
      setPaused(true);
      setMessage(errorText(error));
      setBusy(false);
    }
  }

  async function run(step: Step, controller: AbortController) {
    const op = opRef.current!;
    const { signal } = controller;
    let current = step;
    try {
      if (current === "cancel") {
        setMessage("Cancelling the job…");
        show(await api.cancel(op.session!.job_id, op.keys.cancel, signal));
        current = "poll";
      }
      if (current === "create") {
        setMessage("Creating the upload job…");
        const session = await api.create(op.body!, op.keys.create, signal);
        assertSameInput(session, op.file!, op.sha);
        op.session = session;
        save(op);
        current = "transfer";
      }
      if (current === "transfer") {
        const session = op.session!;
        setMessage(session.transfer_state === "pending"
          ? "Waiting for storage to be ready, then uploading directly to storage…"
          : "Uploading directly to storage…");
        op.confirm = await uploadParts(api, session, op.file!, signal,
          (bytes) => setProgress({ label: "Uploaded", value: bytes, max: op.size }), op.completed);
        current = "confirm";
      }
      if (current === "confirm") {
        setProgress(null);
        setMessage("Confirming the upload…");
        show(await api.confirm(op.session!.job_id, op.confirm!, op.keys.confirm, signal));
        current = "poll";
      }
      setMessage("Processing. Status updates every few seconds.");
      await pollJob(api, op.session!.job_id, signal, show);
      op.failed = null;
      setMessage("Job finished.");
    } catch (error) {
      if (signal.aborted) return;
      op.failed = current;
      const resumable = op.session !== null || (error instanceof ApiError && error.retryable);
      if (!resumable) opRef.current = null;
      setPaused(resumable);
      setMessage(errorText(error));
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  function metadata(): FileMetadata {
    return { source, added, license, author, source_ref: sourceRef,
      per_record_provenance: perRecord || undefined };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || jobActive) return;
    if (!file) {
      setMessage("Select an input file.");
      return;
    }
    const controller = begin();
    setStatus(null);
    setReport(null);
    setNeedsFile(false);
    opRef.current = null;
    try {
      setMessage("Checking the file…");
      const format = await detectFormat(file);
      const sha = await sha256File(file, controller.signal,
        (bytes) => setProgress({ label: "Checksum computed for", value: bytes, max: file.size }));
      const body = createBody(file, metadata(), sha, format);
      opRef.current = { file, sha, size: file.size, body, session: null, completed: [], confirm: null,
        failed: null, keys: { create: newOperationKey(), confirm: newOperationKey(), cancel: newOperationKey() } };
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(errorText(error));
      setProgress(null);
      setBusy(false);
      return;
    }
    await run("create", controller);
  }

  async function resume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const op = opRef.current;
    if (!op || !resumeFile || busy) return;
    const controller = begin();
    try {
      setMessage("Checking that the file matches the unfinished upload…");
      const sha = await sha256File(resumeFile, controller.signal,
        (bytes) => setProgress({ label: "Checksum computed for", value: bytes, max: resumeFile.size }));
      assertSameInput(op.session!, resumeFile, sha);
      op.file = resumeFile;
      setNeedsFile(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(errorText(error));
      setProgress(null);
      setBusy(false);
      return;
    }
    await run(op.failed ?? "transfer", controller);
  }

  async function retry() {
    const op = opRef.current;
    if (!op || busy) return;
    if (!op.file && (op.failed === "create" || op.failed === "transfer")) {
      setNeedsFile(true);
      setMessage("Select the original file to resume the upload.");
      return;
    }
    await run(op.failed ?? "poll", begin());
  }

  async function cancel() {
    abortRef.current?.abort();
    const op = opRef.current;
    if (!op?.session) {
      opRef.current = null;
      setBusy(false);
      setPaused(false);
      setProgress(null);
      setMessage("Upload cancelled before a job was created.");
      return;
    }
    setNeedsFile(false);
    await run("cancel", begin());
  }

  async function refresh() {
    const op = opRef.current;
    if (!op?.session || busy) return;
    await run("poll", begin());
  }

  async function loadReport() {
    const op = opRef.current;
    if (!op?.session) return;
    try {
      setReport(await api.report(op.session.job_id));
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function download() {
    const op = opRef.current;
    if (!op?.session || !view) return;
    try {
      const grant = await api.result(op.session.job_id, view.diagnostic);
      const url = new URL(grant.url);
      if (url.protocol !== "https:") throw new ApiError(200, "invalid_controller_response", false);
      const anchor = document.createElement("a");
      anchor.href = url.href;
      anchor.rel = "noreferrer noopener";
      anchor.referrerPolicy = "no-referrer";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setMessage(view.diagnostic ? "Diagnostic result download started." : "Result download started.");
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  const finished = done && status && VERDICTS.has(status.processing_state);
  const noResult = finished && !view?.resultAllowed && status?.client_phase === "complete"
    && status.processing_state !== "cancelled" && status.processing_state !== "rejected";
  const canCancel = !done && (busy || jobActive || (paused && !!opRef.current));
  const failure = status?.failure_code ? failureLabels[status.failure_code] : null;

  return (
    <main className="pipeline">
      <h1>Data Pipeline Upload</h1>
      <p>JSONL or Parquet. Maximum encoded input: 512 MiB. Limits are enforced by the pipeline.</p>
      <form onSubmit={submit}>
        <label>
          Input file
          <input type="file" required accept=".jsonl,.parquet" onChange={chooseFile} disabled={busy} />
        </label>
        <label>
          Source
          <input required value={source} onChange={(e) => setSource(e.target.value)}
            pattern="[a-z0-9][a-z0-9_]*" maxLength={64} aria-describedby="source-hint" />
        </label>
        <p id="source-hint" className="hint">Lowercase letters, digits and underscores.</p>
        <label>
          Added date
          <input type="date" required value={added} onChange={(e) => setAdded(e.target.value)} />
        </label>
        <label>
          Default license
          <input value={license} onChange={(e) => setLicense(e.target.value)} />
        </label>
        <label>
          Default author
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label>
          Default reference
          <input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} aria-describedby="ref-hint" />
        </label>
        <p id="ref-hint" className="hint">Where the records come from, such as a URL or citation.</p>
        <label className="check">
          <input type="checkbox" checked={perRecord} onChange={(e) => setPerRecord(e.target.checked)} />
          Require a reference in each record
        </label>
        <button type="submit" disabled={busy || jobActive || paused}>Upload</button>
      </form>

      {needsFile && (
        <form onSubmit={resume} className="resume">
          <label>
            Original file
            <input type="file" required accept=".jsonl,.parquet" disabled={busy}
              onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" disabled={busy}>Resume transfer</button>
        </form>
      )}

      <p role="status" aria-live="polite" className="message">{message}</p>
      {progress && (
        <p>
          <progress value={progress.value} max={progress.max} aria-label={progress.label} />
          {" "}{progress.label} {Math.floor((progress.value / Math.max(progress.max, 1)) * 100)}%
        </p>
      )}

      {status && view && (
        <section aria-label="Job status" className="job">
          <h2 ref={headingRef} tabIndex={-1}>{view.title}</h2>
          <p>
            Processing: {processingLabels[status.processing_state]}.
            {" "}Publication: {publicationLabels[status.publication_state]}.
            {" "}Cleanup: {cleanupLabels[status.cleanup_state]}.
          </p>
          {failure && <p>Reason: {failure}.</p>}
          {status.processing_state === "uploading" && !done && (
            <p>Upload deadline: {when(status.upload_deadline)}.</p>
          )}
          {status.client_phase === "finalizing" && (
            <p>Publication or cleanup is still pending.</p>
          )}
          {updatedAt !== null && <p>Last update: {when(updatedAt)}.</p>}
          {status.expires_at && status.client_phase !== "expired" && (
            <p>Report and result available until {when(status.expires_at)}.</p>
          )}
          {noResult && <p>No result available.</p>}
        </section>
      )}

      <div className="actions">
        {view?.resultAllowed && (
          <button type="button" onClick={download}>
            {view.diagnostic ? "Download diagnostic result" : "Download result"}
          </button>
        )}
        {view?.reportAllowed && <button type="button" onClick={loadReport}>View report</button>}
        {paused && <button type="button" ref={retryRef} onClick={retry}>Retry</button>}
        {done && !busy && <button type="button" onClick={refresh}>Refresh status</button>}
        {canCancel && <button type="button" onClick={cancel}>Cancel job</button>}
      </div>

      {report && (
        <section aria-label="QA report" className="report">
          <h2>QA report</h2>
          <p>Outcome: {report.outcome === "passed" ? "passed" : report.outcome === "failed_qa"
            ? "QA failed (diagnostic only)" : "failed"}.</p>
          <p>Rows read: {report.rows_in}. Rows written: {report.rows_out}.</p>
          <p>PERSON and street-address coverage is unmeasured.</p>
          {report.qa ? (
            <>
              <h3>Blocking checks</h3>
              <ul>
                {report.qa.binding_checks.map((check) => (
                  <li key={check.name}>
                    {check.name.replace(/_/g, " ")}: {check.status.replace(/_/g, " ")}; count:{" "}
                    {check.count ?? "not evaluated"}
                  </li>
                ))}
              </ul>
              <h3>Warnings (do not block)</h3>
              <ul>
                {report.qa.advisory_checks.map((check) => (
                  <li key={check.name}>
                    {check.name.replace(/_/g, " ")}: {check.count ?? "not evaluated"}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>QA was not evaluated.</p>
          )}
        </section>
      )}
    </main>
  );
}
