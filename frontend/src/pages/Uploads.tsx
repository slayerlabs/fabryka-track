import { useEffect, useRef, useState } from "react";
import { useGetIdentity } from "@refinedev/core";
import { Link, Navigate, useParams } from "react-router";
import { bindingLabel, describeJob, humanize, modeLabel } from "../uploads/display";
import { checksOpen, summarizeReport } from "../uploads/report";
import { apiError } from "../provider";
import { HuggingFaceButton } from "./Account";
import {
  getReport,
  getUpload,
  listPipelines,
  listUploads,
  resultGrant,
  type UploadJob,
  type UploadPipeline,
  type UploadReport,
} from "../uploads/api";

const POLL_MS = 5000;
const PAGE_SIZE = 20;

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function when(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function size(bytes?: number | null) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export interface Pipelines {
  list: UploadPipeline[];
  loaded: boolean;
  error: string;
}

export function usePipelines(): Pipelines {
  const [value, setValue] = useState<Pipelines>({ list: [], loaded: false, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    listPipelines(controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) setValue({ list: reply.pipelines ?? [], loaded: true, error: "" });
      },
      (e) => {
        if (!controller.signal.aborted) setValue({ list: [], loaded: true, error: message(e) });
      },
    );
    return () => controller.abort();
  }, []);
  return value;
}

export function UploadsPage() {
  const identity = useGetIdentity<{ huggingface_username?: string | null } | null>();
  if (identity.isLoading) return <p className="muted">Loading…</p>;
  if (identity.error)
    return (
      <p className="error" role="alert">
        {message(identity.error)}
      </p>
    );
  if (!identity.data?.huggingface_username)
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
      <section className="panel">
        <div className="eyebrow">Data pipeline</div>
        <h1>Data uploads</h1>
        <p className="muted">
          Send a Dynaword file to the data pipeline, follow its validation and download the
          report and result.
        </p>
        <p className="muted">
          <Link to="/uploads/new">Start a guided upload</Link> step by step.
        </p>
      </section>
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
                  const step = described.terminal ? 4 : 3;
                  return (
                    <tr key={job.job_id}>
                      <td>
                        <Link
                          to={`/uploads/new?step=${step}&job=${encodeURIComponent(job.job_id)}&pipeline=${encodeURIComponent(job.pipeline)}`}
                        >
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

export function ReportSummary({ id }: { id: string }) {
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
      {summarizeReport(report).map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <dl>
            {section.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {checks.length > 0 && (
        <details open={checksOpen(report)}>
          <summary>Quality checks</summary>
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
        </details>
      )}
    </>
  );
}

export function ResultDownload({ id, diagnosticFirst, attribution = false }: {
  id: string; diagnosticFirst: boolean; attribution?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState(diagnosticFirst);
  async function download(asDiagnostic: boolean, kind: "result" | "attribution" = "result") {
    setBusy(true);
    setError("");
    try {
      window.location.assign((await resultGrant(id, asDiagnostic, kind)).url);
    } catch (e) {
      if (apiError(e).code === "diagnostic_required") setDiagnostic(true);
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
        {!diagnosticFirst && (
          <button className="primary" disabled={busy} onClick={() => void download(false)}>
            Download result
          </button>
        )}
        {attribution && (
          <button className="secondary" disabled={busy} onClick={() => void download(diagnostic, "attribution")}>
            Download attribution
          </button>
        )}
        {diagnostic && (
          <button className="secondary" disabled={busy} onClick={() => void download(true)}>
            Download diagnostic result
          </button>
        )}
      </div>
    </>
  );
}

export function UploadDetailRedirect() {
  const { id = "" } = useParams();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getUpload(id, controller.signal).then(
      (job) => {
        if (controller.signal.aborted) return;
        const step = describeJob(job).terminal ? 4 : 3;
        setTarget(
          `/uploads/new?step=${step}&job=${encodeURIComponent(job.job_id)}&pipeline=${encodeURIComponent(job.pipeline)}`,
        );
      },
      (e) => {
        if (!controller.signal.aborted) setError(message(e));
      },
    );
    return () => controller.abort();
  }, [id]);

  if (error) {
    return (
      <section className="panel">
        <Link to="/uploads">← Data uploads</Link>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!target) return <p className="muted">Loading upload…</p>;
  return <Navigate to={target} replace />;
}
