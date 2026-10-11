import { useEffect, useRef, useState, type FormEvent } from "react";
import { useGetIdentity } from "@refinedev/core";
import { Link, useNavigate, useParams } from "react-router";
import { PageTop } from "../PageTop";
import { MAX_UPLOAD_LABEL, validateUpload, type UploadErrors, type UploadFormState } from "../uploads/form";
import { uploadFile, type UploadProgress } from "../uploads/uploader";
import { describeJob, errorMessage as message, failureHint, formatWhen as when, keepPolling, modeLabel, rejectionMessage, stoppedMessage } from "../uploads/display";
import { HuggingFaceButton } from "./Account";
import { FieldError, MetadataFields, emptyForm } from "../uploads/MetadataFields";
import { usePipelines, type Pipelines } from "../uploads/usePipelines";
import { JobFacts } from "../uploads/JobFacts";
import { ReportDetails, ResultDownload } from "../uploads/ReportDetails";
import {
  browserUploaderDeps,
  cancelUpload,
  getReport,
  getUpload,
  listUploads,
  type UploadJob,
  type UploadReport,
} from "../uploads/api";

const POLL_MS = 5000;
const PAGE_SIZE = 20;

function size(bytes?: number | null) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const PROGRESS_LABELS: Record<UploadProgress["phase"], string> = {
  hashing: "Checking file",
  preparing: "Preparing upload",
  uploading: "Uploading",
  confirming: "Confirming upload",
};

function NewUploadForm({ pipelines }: { pipelines: Pipelines }) {
  const navigate = useNavigate();
  const [state, setState] = useState<UploadFormState>(emptyForm);
  const [errors, setErrors] = useState<UploadErrors>({});
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const lastPhase = useRef<UploadProgress["phase"]>("hashing");
  const abort = useRef<AbortController | null>(null);
  const busy = progress !== null;
  const noModes = pipelines.loaded && !pipelines.error && pipelines.list.length === 0;
  const onlyMode = pipelines.list.length === 1 ? pipelines.list[0].pipeline : "";

  useEffect(() => {
    if (onlyMode) setState((current) => (current.pipeline ? current : { ...current, pipeline: onlyMode }));
  }, [onlyMode]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const set = <K extends keyof UploadFormState>(key: K, value: UploadFormState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const { file } = state;
    const result = validateUpload(state);
    setErrors(result.errors);
    if (!result.form || !file) return;
    const controller = new AbortController();
    abort.current = controller;
    lastPhase.current = "hashing";
    setProgress({ phase: "hashing", loaded: 0, total: file.size });
    try {
      const jobId = await uploadFile(file, result.form, browserUploaderDeps(), {
        signal: controller.signal,
        onProgress: (next) => {
          lastPhase.current = next.phase;
          setProgress(next);
        },
      });
      navigate(`/uploads/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setError(controller.signal.aborted ? stoppedMessage(lastPhase.current) : message(e));
      setProgress(null);
    }
  }

  return (
    <section className="panel">
      <h2>New upload</h2>
      <p className="muted">
        Upload one JSONL or Parquet file of up to {MAX_UPLOAD_LABEL}. Keep this tab open until the upload
        finishes; an interrupted upload cannot be resumed and has to be started again.
      </p>
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>Mode</span>
          <select
            value={state.pipeline}
            disabled={busy || !pipelines.list.length}
            onChange={(event) => set("pipeline", event.target.value)}
          >
            {pipelines.list.length !== 1 && <option value="">Choose a mode</option>}
            {pipelines.list.map(({ pipeline, title }) => (
              <option key={pipeline} value={pipeline}>
                {title}
              </option>
            ))}
          </select>
          {!pipelines.loaded && <small className="muted">Loading modes…</small>}
          {pipelines.error && (
            <small className="error" role="alert">
              {pipelines.error}
            </small>
          )}
          {noModes && (
            <small className="error" role="alert">
              No upload modes are available right now.
            </small>
          )}
          <FieldError text={errors.pipeline} />
        </label>
        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept=".jsonl,.parquet"
            disabled={busy}
            onChange={(event) => set("file", event.target.files?.[0] ?? null)}
          />
          <small className="muted">The format is taken from the file extension.</small>
          <FieldError text={errors.file} />
        </label>
        <MetadataFields state={state} errors={errors} disabled={busy} set={set} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {progress && (
          <p className="notice" role="status">
            {PROGRESS_LABELS[progress.phase]} ·{" "}
            {progress.total ? Math.floor((progress.loaded / progress.total) * 100) : 0}%
          </p>
        )}
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !pipelines.list.length}>
            {busy ? "Uploading…" : "Upload file"}
          </button>
          {busy && progress.phase !== "confirming" && (
            <button className="secondary" type="button" onClick={() => abort.current?.abort()}>
              Stop upload
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function UploadsPage() {
  const identity = useGetIdentity<{ huggingface_username?: string | null } | null>();
  return (
    <>
      <PageTop
        description={
          !identity.isLoading && !identity.error && identity.data?.huggingface_username
            ? "Send a Dynaword file to the data pipeline, follow its validation and download the report and result."
            : undefined
        }
      />
      {identity.isLoading ? (
        <p className="muted">Loading…</p>
      ) : identity.error ? (
        <p className="error" role="alert">
          {message(identity.error)}
        </p>
      ) : !identity.data?.huggingface_username ? (
        <section className="panel">
          <p className="notice">Sign in with Hugging Face to upload data.</p>
          <HuggingFaceButton link />
        </section>
      ) : (
        <UploadsWorkspace />
      )}
    </>
  );
}

function UploadsWorkspace() {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const pipelines = usePipelines();
  const unmounted = useRef(new AbortController());
  const active = jobs.some((job) => !describeJob(job).terminal);

  async function load(next?: string | null) {
    const signal = unmounted.current.signal;
    try {
      const page = await listUploads(next, signal);
      setJobs((current) => (next ? [...current, ...page.jobs] : page.jobs));
      setCursor(page.next_cursor);
      setError("");
    } catch (e) {
      if (!signal.aborted) setError(message(e));
    } finally {
      if (!signal.aborted) {
        setLoaded(true);
        setRefreshes((count) => count + 1);
      }
    }
  }

  async function loadMore(next: string) {
    setLoadingMore(true);
    await load(next);
    setLoadingMore(false);
  }

  useEffect(() => {
    // Created per mount so StrictMode's dev remount does not inherit an aborted controller.
    const controller = new AbortController();
    unmounted.current = controller;
    void load();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    // Refreshing replaces the list with page one, so it would drop pages loaded with "Load more".
    if (!active || loadingMore || jobs.length > PAGE_SIZE) return;
    // Rescheduled after each completed load, so refreshes never overlap.
    const timer = setTimeout(() => void load(), POLL_MS * 3);
    return () => clearTimeout(timer);
  }, [active, loadingMore, jobs.length, refreshes]);

  return (
    <>
      <NewUploadForm pipelines={pipelines} />
      <section className="panel">
        <h2>Your uploads</h2>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loaded ? (
          <p className="muted">Loading uploads…</p>
        ) : jobs.length === 0 ? (
          <p className="muted">No uploads yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Upload</th>
                  <th>Mode</th>
                  <th>Phase</th>
                  <th>Outcome</th>
                  <th>Size</th>
                  <th>Started</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const described = describeJob(job);
                  return (
                    <tr key={job.job_id}>
                      <td>
                        <Link to={`/uploads/${encodeURIComponent(job.job_id)}`}>
                          {job.job_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td>{modeLabel(job.pipeline, pipelines.list)}</td>
                      <td>{described.phase}</td>
                      <td>{described.outcome}</td>
                      <td>{size(job.encoded_bytes)}</td>
                      <td>{when(job.upload_started_at)}</td>
                      <td>{when(described.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="actions">
            <button className="secondary" disabled={loadingMore} onClick={() => void loadMore(cursor)}>
              Load more
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function ReportSummary({ id }: { id: string }) {
  const [report, setReport] = useState<UploadReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    getReport(id, controller.signal).then(setReport, (e) => {
      if (!controller.signal.aborted) setError(message(e));
    });
    return () => controller.abort();
  }, [id]);
  if (error) return <p className="muted">{error}</p>;
  if (!report) return <p className="muted">Loading report…</p>;
  return <ReportDetails report={report} />;
}

export function UploadDetailPage() {
  const { id = "" } = useParams();
  return <UploadDetail key={id} id={id} />;
}

function UploadDetail({ id }: { id: string }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const pipelines = usePipelines();
  const described = job && describeJob(job);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const next = await getUpload(id, controller.signal);
        setJob(next);
        setError("");
        if (describeJob(next).terminal) return;
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
  }, [id]);

  async function cancel() {
    if (!window.confirm("Cancel this upload? This cannot be undone.")) return;
    setCancelling(true);
    try {
      setJob(await cancelUpload(id));
    } catch (e) {
      setError(message(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <PageTop
        title={`Upload ${id.slice(0, 8)}`}
        ancestors={[{ label: "Home", to: "/" }, { label: "Data uploads", to: "/uploads" }]}
      />
      <section className="panel">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!job || !described ? (
          !error && <p className="muted">Loading upload…</p>
        ) : (
          <>
            <JobFacts job={job} pipelines={pipelines.list} />
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
                <button className="secondary" disabled={cancelling} onClick={() => void cancel()}>
                  {cancelling ? "Cancelling…" : "Cancel upload"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {described?.hasReport && (
        <section className="panel">
          <h2>Report</h2>
          <ReportSummary id={id} />
          <ResultDownload id={id} diagnosticFirst={described.diagnosticOnly} />
        </section>
      )}
    </>
  );
}
