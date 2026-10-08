import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  DECLARATION_TEXT,
  validateUpload,
  type UploadErrors,
  type UploadFormState,
} from "../uploads/form";
import { uploadFile, type UploadProgress } from "../uploads/uploader";
import { bindingLabel, humanize, stoppedMessage } from "../uploads/display";
import { request } from "../provider";
import { HuggingFaceButton } from "./Account";
import {
  browserUploaderDeps,
  cancelUpload,
  getReport,
  getUpload,
  listUploads,
  PHASE_LABELS,
  resultGrant,
  TERMINAL_PHASES,
  type UploadJob,
  type UploadReport,
} from "../uploads/api";

const POLL_MS = 5000;
const PAGE_SIZE = 20;

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function when(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function size(bytes?: number | null) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function phase(job: UploadJob) {
  return PHASE_LABELS[job.client_phase] ?? job.client_phase;
}

function outcome(job: UploadJob) {
  if (job.failure_code) return humanize(job.failure_code);
  if (job.client_phase === "complete") return job.publication_state ? humanize(job.publication_state) : "Done";
  return "—";
}

function lastUpdate(job: UploadJob) {
  return [job.first_result_stored_at, job.admitted_at, job.upload_started_at]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

const PROGRESS_LABELS: Record<UploadProgress["phase"], string> = {
  hashing: "Checking file",
  preparing: "Preparing upload",
  uploading: "Uploading",
  confirming: "Confirming upload",
};

const emptyForm = (): UploadFormState => ({
  file: null,
  source: "",
  added: new Date().toISOString().slice(0, 10),
  license: "",
  author: "",
  source_ref: "",
  per_record_provenance: false,
  mask_names: "",
  declaration: false,
});

function FieldError({ text }: { text?: string }) {
  return text ? (
    <small className="error" role="alert">
      {text}
    </small>
  ) : null;
}

function NewUploadForm() {
  const navigate = useNavigate();
  const [state, setState] = useState<UploadFormState>(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<UploadErrors>({});
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const lastPhase = useRef<UploadProgress["phase"]>("hashing");
  const abort = useRef<AbortController | null>(null);
  const busy = progress !== null;

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
        Upload one JSONL or Parquet file of up to 512 MiB. Keep this tab open until the upload
        finishes; an interrupted upload cannot be resumed and has to be started again.
      </p>
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept=".jsonl,.parquet"
            disabled={busy}
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              setFile(chosen);
              set("file", chosen && { name: chosen.name, size: chosen.size });
            }}
          />
          <small className="muted">The format is taken from the file extension.</small>
          <FieldError text={errors.file} />
        </label>
        <div className="fields">
          <label className="field">
            <span>Source</span>
            <input
              value={state.source}
              disabled={busy}
              placeholder="my_source"
              onChange={(event) => set("source", event.target.value)}
            />
            <small className="muted">Lowercase letters, digits and underscores.</small>
            <FieldError text={errors.source} />
          </label>
          <label className="field">
            <span>Added</span>
            <input
              type="date"
              value={state.added}
              disabled={busy}
              onChange={(event) => set("added", event.target.value)}
            />
            <FieldError text={errors.added} />
          </label>
          <label className="field">
            <span>License (optional)</span>
            <input
              value={state.license}
              disabled={busy}
              placeholder="cc-by-4.0"
              onChange={(event) => set("license", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Author (optional)</span>
            <input
              value={state.author}
              disabled={busy}
              onChange={(event) => set("author", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Source reference (optional)</span>
            <input
              value={state.source_ref}
              disabled={busy}
              placeholder="https://"
              onChange={(event) => set("source_ref", event.target.value)}
            />
          </label>
          <div className="field">
            <span>Provenance</span>
            <label>
              <input
                type="checkbox"
                checked={state.per_record_provenance}
                disabled={busy}
                onChange={(event) => set("per_record_provenance", event.target.checked)}
              />{" "}
              Records carry their own provenance
            </label>
          </div>
        </div>
        <fieldset
          className="field"
          style={{ border: 0, padding: 0, minWidth: 0 }}
          disabled={busy}
          role="radiogroup"
          aria-labelledby="mask-names-label"
        >
          <span id="mask-names-label">Mask personal names?</span>
          <label>
            <input
              type="radio"
              name="mask_names"
              checked={state.mask_names === "yes"}
              onChange={() => set("mask_names", "yes")}
            />{" "}
            Yes, mask names
          </label>{" "}
          <label>
            <input
              type="radio"
              name="mask_names"
              checked={state.mask_names === "no"}
              onChange={() => set("mask_names", "no")}
            />{" "}
            No, keep names
          </label>
          <FieldError text={errors.mask_names} />
        </fieldset>
        <div className="field">
          <span>Declaration</span>
          <label>
            <input
              type="checkbox"
              checked={state.declaration}
              disabled={busy}
              onChange={(event) => set("declaration", event.target.checked)}
            />{" "}
            {DECLARATION_TEXT}
          </label>
          <FieldError text={errors.declaration} />
        </div>
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
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Uploading…" : "Upload file"}
          </button>
          {busy && (
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
  const [linked, setLinked] = useState<boolean | null>(null);
  useEffect(() => {
    request<{ user: { huggingface_username?: string | null } | null }>("/api/auth/me").then(
      ({ user }) => setLinked(Boolean(user?.huggingface_username)),
      () => setLinked(true),
    );
  }, []);
  if (linked === false)
    return (
      <section className="panel">
        <div className="eyebrow">Data pipeline</div>
        <h1>Data uploads</h1>
        <p className="notice">Sign in with Hugging Face to upload data.</p>
        <HuggingFaceButton link />
      </section>
    );
  return <UploadsWorkspace />;
}

function UploadsWorkspace() {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const active = jobs.some((job) => !TERMINAL_PHASES.has(job.client_phase));

  async function load(next?: string | null) {
    try {
      const page = await listUploads(next);
      setJobs((current) => (next ? [...current, ...page.jobs] : page.jobs));
      setCursor(page.next_cursor);
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    // Refreshing replaces the list with page one, so it would drop pages loaded with "Load more".
    if (!active || jobs.length > PAGE_SIZE) return;
    const timer = setInterval(() => void load(), POLL_MS * 3);
    return () => clearInterval(timer);
  }, [active, jobs.length]);

  return (
    <>
      <section className="panel">
        <div className="eyebrow">Data pipeline</div>
        <h1>Data uploads</h1>
        <p className="muted">
          Send a Dynaword file to the data pipeline, follow its validation and download the
          report and result.
        </p>
      </section>
      <NewUploadForm />
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
                  <th>Phase</th>
                  <th>Outcome</th>
                  <th>Size</th>
                  <th>Started</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <Link to={`/uploads/${encodeURIComponent(job.job_id)}`}>
                        {job.job_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{phase(job)}</td>
                    <td>{outcome(job)}</td>
                    <td>{size(job.encoded_bytes)}</td>
                    <td>{when(job.upload_started_at)}</td>
                    <td>{when(lastUpdate(job))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="actions">
            <button className="secondary" onClick={() => void load(cursor)}>
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
  const checks = report.report?.qa?.checks ?? [];
  return (
    <>
      <p>
        <strong>Verdict:</strong> {report.verdict === "failed_qa" ? "Failed quality checks" : humanize(report.verdict)}
        {report.failure_code && <> · {humanize(report.failure_code)}</>}
      </p>
      <p>
        Rows in: {report.report?.rows_in ?? "—"} · Rows out: {report.report?.rows_out ?? "—"}
      </p>
      {checks.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Binding</th>
                <th>Status</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check, index) => (
                <tr key={`${check.name}-${index}`}>
                  <td>{check.name ?? "—"}</td>
                  <td>{bindingLabel(check.binding)}</td>
                  <td>{humanize(check.status)}</td>
                  <td>{check.count ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ResultDownload({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState(false);
  async function download(asDiagnostic: boolean) {
    setBusy(true);
    setError("");
    try {
      window.location.assign((await resultGrant(id, asDiagnostic)).url);
    } catch (e) {
      if ((e as { code?: string }).code === "diagnostic_required") setDiagnostic(true);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void download(false)}>
          Download result
        </button>
        {diagnostic && (
          <button className="secondary" disabled={busy} onClick={() => void download(true)}>
            Download diagnostic result
          </button>
        )}
      </div>
    </>
  );
}

export function UploadDetailPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const terminal = job ? TERMINAL_PHASES.has(job.client_phase) : false;

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      getUpload(id, controller.signal).then(
        (next) => {
          setJob(next);
          setError("");
        },
        (e) => {
          if (!controller.signal.aborted) setError(message(e));
        },
      );
    void refresh();
    const timer = terminal ? undefined : setInterval(refresh, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [id, terminal]);

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
      <section className="panel">
        <Link to="/uploads">← Data uploads</Link>
        <h1>Upload {id.slice(0, 8)}</h1>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!job ? (
          !error && <p className="muted">Loading upload…</p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr><th>Phase</th><td>{phase(job)}</td></tr>
                  <tr><th>Outcome</th><td>{outcome(job)}</td></tr>
                  <tr><th>Size</th><td>{size(job.encoded_bytes)}</td></tr>
                  <tr><th>SHA-256</th><td><code>{job.input_sha256 ?? "—"}</code></td></tr>
                  <tr><th>Upload started</th><td>{when(job.upload_started_at)}</td></tr>
                  <tr><th>Upload deadline</th><td>{when(job.upload_deadline)}</td></tr>
                  <tr><th>Admitted</th><td>{when(job.admitted_at)}</td></tr>
                  <tr><th>Result stored</th><td>{when(job.first_result_stored_at)}</td></tr>
                  <tr><th>Expires</th><td>{when(job.expires_at)}</td></tr>
                </tbody>
              </table>
            </div>
            {!terminal && (
              <div className="actions">
                <button className="secondary" disabled={cancelling} onClick={() => void cancel()}>
                  {cancelling ? "Cancelling…" : "Cancel upload"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {job && (job.client_phase === "complete" || job.client_phase === "rejected") && (
        <section className="panel">
          <h2>Report</h2>
          <ReportSummary id={id} />
          <ResultDownload id={id} />
        </section>
      )}
    </>
  );
}
