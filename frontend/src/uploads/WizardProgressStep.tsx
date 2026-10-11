import { useEffect, useReducer, useRef, useState } from "react";
import { browserUploaderDeps, cancelUpload, getUpload, type UploadPipeline } from "./api";
import { COPY } from "./copy";
import { canCancel, describeJob, errorMessage, failureHint, keepPolling, publishingResults, rejectionMessage } from "./display";
import type { UploadForm } from "./form";
import { JobFacts } from "./JobFacts";
import { isFinal, timeline } from "./phases";
import { initialProgress, progressReducer, timelineInput } from "./progress";
import { duration } from "./report";
import { Timeline } from "./Timeline";
import { uploadFile } from "./uploader";

const POLL_MS = 5000;

export interface UploadSource {
  file: File;
  form: UploadForm;
}

interface Props {
  jobId: string;
  source: UploadSource | null;
  pipelines: UploadPipeline[];
  onJobCreated: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
  onFinished: () => void;
}

function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function WizardProgressStep({ jobId, source, pipelines, onJobCreated, onBusyChange, onFinished }: Props) {
  const [state, dispatch] = useReducer(progressReducer, initialProgress);
  const abort = useRef<AbortController | null>(null);
  const running = state.job?.client_phase === "running";
  const now = useClock(running);
  const described = state.job ? describeJob(state.job) : null;

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const job = await getUpload(jobId, controller.signal);
        dispatch({ type: "polled", job, now: Date.now() });
        if (isFinal(job.client_phase)) return;
      } catch (e) {
        if (controller.signal.aborted) return;
        dispatch({ type: "poll-failed", message: errorMessage(e) });
        if (!keepPolling(e)) return;
      }
      timer = setTimeout(refresh, POLL_MS);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (state.advance) onFinished();
  }, [state.advance]);

  useEffect(() => {
    onBusyChange(state.uploading);
    if (!state.uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      onBusyChange(false);
    };
  }, [state.uploading]);

  useEffect(() => () => abort.current?.abort(), []);

  async function start() {
    if (!source) return;
    const controller = new AbortController();
    abort.current = controller;
    dispatch({ type: "upload-started", total: source.file.size });
    try {
      const id = await uploadFile(source.file, source.form, browserUploaderDeps(), {
        signal: controller.signal,
        onProgress: (progress) => dispatch({ type: "upload-progress", progress }),
      });
      dispatch({ type: "upload-finished" });
      onJobCreated(id);
    } catch (e) {
      dispatch({ type: "upload-failed", message: errorMessage(e), aborted: controller.signal.aborted });
    }
  }

  async function cancel() {
    if (!window.confirm(COPY.progress.confirmCancel)) return;
    dispatch({ type: "cancel-started" });
    try {
      dispatch({ type: "cancelled", job: await cancelUpload(jobId), now: Date.now() });
    } catch (e) {
      dispatch({ type: "cancel-failed", message: errorMessage(e) });
    }
  }

  const job = state.job;
  const idle = !jobId && !state.uploading;
  const stoppable = state.uploading && state.upload?.phase !== "confirming";
  const elapsed = state.runningSince === null ? null : duration(Math.max(0, now - state.runningSince));
  const finished = job !== null && isFinal(job.client_phase);

  return (
    <>
      <section className="panel">
        <h2>{COPY.steps[2].title}</h2>
        {idle && <p className="muted">{COPY.progress.ready}</p>}
        {jobId && !job && !state.error && <p className="muted">{COPY.progress.loading}</p>}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <Timeline nodes={timeline(timelineInput(state))} upload={state.upload} elapsed={elapsed} />
        {job?.client_phase === "finalizing" && (
          <p className="notice" role="status">
            {publishingResults(job) ? COPY.messages.publishing : COPY.messages.finishing}
          </p>
        )}
        {job && finished && described && (
          <p className="notice" role="status">
            {described.outcome}
          </p>
        )}
        {job && failureHint(job) && <p className="notice">{failureHint(job)}</p>}
        {job && rejectionMessage(job) && <p className="notice">{rejectionMessage(job)}</p>}
        <div className="actions">
          {idle && (
            <button className="primary" type="button" disabled={!source} onClick={() => void start()}>
              {COPY.progress.start}
            </button>
          )}
          {stoppable && (
            <button className="secondary" type="button" onClick={() => abort.current?.abort()}>
              {COPY.progress.stop}
            </button>
          )}
          {job && canCancel(job) && (
            <button className="secondary" type="button" disabled={state.cancelling} onClick={() => void cancel()}>
              {state.cancelling ? COPY.progress.cancelling : COPY.progress.cancel}
            </button>
          )}
          {finished && (
            <button className="primary" type="button" onClick={onFinished}>
              {COPY.progress.viewResults}
            </button>
          )}
        </div>
      </section>
      <section className="panel">
        <h3>{COPY.progress.recipeHeading}</h3>
        <ol className="recipe-stages">
          {COPY.recipeStages.map((stage) => (
            <li key={stage}>{stage}</li>
          ))}
        </ol>
      </section>
      {job && (
        <section className="panel">
          <h3>{COPY.progress.factsHeading}</h3>
          <JobFacts job={job} pipelines={pipelines} />
        </section>
      )}
    </>
  );
}
