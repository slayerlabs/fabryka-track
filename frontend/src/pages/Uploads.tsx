import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { formatBytes } from "../uploads/bytes";
import { COPY } from "../uploads/copy";
import { describeJob, errorMessage as message, formatWhen as when, modeLabel, versionChip } from "../uploads/display";
import { HuggingFaceGate } from "../uploads/HuggingFaceGate";
import { jobUrl } from "../uploads/location";
import { usePipelines } from "../uploads/usePipelines";
import { getUpload, listUploads, type UploadJob } from "../uploads/api";

const POLL_MS = 5000;
const PAGE_SIZE = 20;

export function UploadsPage() {
  return (
    <HuggingFaceGate
      description={COPY.history.description}
      actions={
        <Link className="primary" to="/uploads/new">
          {COPY.results.newUpload}
        </Link>
      }
    >
      <UploadsWorkspace />
    </HuggingFaceGate>
  );
}

export function UploadRedirectPage() {
  return (
    <HuggingFaceGate>
      <UploadRedirect />
    </HuggingFaceGate>
  );
}

function UploadRedirect() {
  const { id = "" } = useParams();
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    getUpload(id, controller.signal).then(
      (job) => setTarget(jobUrl(job)),
      (e) => {
        if (!controller.signal.aborted) setError(message(e));
      },
    );
    return () => controller.abort();
  }, [id]);
  if (target) return <Navigate to={target} replace />;
  if (error)
    return (
      <section className="panel">
        <p className="error" role="alert">
          {error}
        </p>
        <Link to="/uploads">{COPY.history.back}</Link>
      </section>
    );
  return <p className="muted">{COPY.progress.loading}</p>;
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
        <h2>{COPY.history.heading}</h2>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loaded ? (
          <p className="muted">{COPY.history.loading}</p>
        ) : jobs.length === 0 ? (
          <p className="muted">{COPY.history.empty}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{COPY.history.columns.upload}</th>
                  <th>{COPY.history.columns.source}</th>
                  <th>{COPY.history.columns.mode}</th>
                  <th>{COPY.history.columns.phase}</th>
                  <th>{COPY.history.columns.outcome}</th>
                  <th>{COPY.history.columns.size}</th>
                  <th>{COPY.history.columns.started}</th>
                  <th>{COPY.history.columns.updated}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const described = describeJob(job);
                  return (
                    <tr key={job.job_id}>
                      <td>
                        <Link to={jobUrl(job)}>
                          {job.job_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td>
                        {job.source_version ? (
                          <>
                            {job.source_version.source} ·{" "}
                            <span className={`chip ${job.source_version.current ? "chip-current" : "chip-old"}`}>
                              {versionChip(job.source_version)}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{modeLabel(job.pipeline, pipelines.list)}</td>
                      <td>{described.phase}</td>
                      <td>{described.outcome}</td>
                      <td>{job.encoded_bytes == null ? "—" : formatBytes(job.encoded_bytes)}</td>
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
              {COPY.history.loadMore}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
