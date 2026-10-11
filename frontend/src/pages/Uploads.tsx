import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { describeJob, errorMessage as message, formatWhen as when, modeLabel } from "../uploads/display";
import { HuggingFaceGate } from "../uploads/HuggingFaceGate";
import { jobUrl } from "../uploads/location";
import { usePipelines } from "../uploads/usePipelines";
import { getUpload, listUploads, type UploadJob } from "../uploads/api";

const POLL_MS = 5000;
const PAGE_SIZE = 20;

function size(bytes?: number | null) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function UploadsPage() {
  return (
    <HuggingFaceGate description="Send a Dynaword file to the data pipeline, follow its validation and download the report and result.">
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
        <Link to="/uploads">Back to your uploads</Link>
      </section>
    );
  return <p className="muted">Loading upload…</p>;
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
        <div className="actions">
          <h2>Your uploads</h2>
          <Link className="primary" to="/uploads/new">
            New upload
          </Link>
        </div>
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
                        <Link to={jobUrl(job)}>
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
