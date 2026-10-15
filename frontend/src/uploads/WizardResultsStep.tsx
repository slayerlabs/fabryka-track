import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { getReport, getUpload, type UploadJob, type UploadPipeline } from "./api";
import { COPY } from "./copy";
import { describeJob, errorMessage, failureHint, hasAttribution, humanize, rejectionMessage } from "./display";
import { JobFacts } from "./JobFacts";
import { ReportDetails, ResultDownload } from "./ReportDetails";
import { ResultCharts } from "./ResultCharts";
import { loadUploadResults, summarize, type UploadResults } from "./results";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "done"; results: UploadResults };

const count = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));

function Metric({ label, children }: { label: string; children: string }) {
  return (
    <div className="metric">
      <small>{label}</small>
      <strong>{children}</strong>
    </div>
  );
}

interface Props {
  jobId: string;
  pipelines: UploadPipeline[];
  onUnfinished: () => void;
  onJob: (job: UploadJob) => void;
}

export function WizardResultsStep({ jobId, pipelines, onUnfinished, onJob }: Props) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    loadUploadResults(jobId, { getUpload, getReport }, controller.signal).then(
      (results) => {
        if (controller.signal.aborted) return;
        setLoad({ status: "done", results });
        onJob(results.job);
      },
      (e) => {
        if (!controller.signal.aborted) setLoad({ status: "error", message: errorMessage(e) });
      },
    );
    return () => controller.abort();
  }, [jobId]);

  const results = load.status === "done" ? load.results : null;
  const unfinished = results !== null && !describeJob(results.job).terminal;
  useEffect(() => {
    if (unfinished) onUnfinished();
  }, [unfinished]);
  const summary = useMemo(() => summarize(results?.report ?? null), [results]);

  if (load.status === "loading") return <p className="muted">{COPY.results.loading}</p>;
  if (!results)
    return (
      <p className="error" role="alert">
        {load.status === "error" && load.message}
      </p>
    );

  const { job, report, reportError } = results;
  const described = describeJob(job);
  const { cards } = summary;
  const expired = job.client_phase === "expired";
  const failure = rejectionMessage(job) ?? failureHint(job);

  return (
    <>
      <section className="panel">
        <h2>{COPY.steps[3].title}</h2>
        {report ? (
          <>
            <div className="metrics">
              <Metric label={COPY.cards.verdict}>
                {cards.verdict ? COPY.verdicts[cards.verdict as keyof typeof COPY.verdicts] ?? humanize(cards.verdict) : "—"}
              </Metric>
              <Metric label={COPY.cards.rows}>{`${count(cards.rowsIn)} → ${count(cards.rowsOut)}`}</Metric>
              <Metric label={COPY.cards.checks}>
                {cards.checksTotal === null ? "—" : `${cards.checksPassed} / ${cards.checksTotal}`}
              </Metric>
              <Metric label={COPY.cards.tokens}>{count(cards.tokens)}</Metric>
            </div>
            {cards.failureCode && <p className="notice">{humanize(cards.failureCode)}</p>}
            <ResultCharts summary={summary} />
          </>
        ) : (
          <>
            <p className="notice" role="status">
              {expired ? COPY.results.expired : described.terminal ? described.outcome : COPY.results.inProgress}
            </p>
            {failure && <p className="notice">{failure}</p>}
            {reportError && (
              <p className="error" role="alert">
                {reportError}
              </p>
            )}
            {!expired && !reportError && <p className="muted">{COPY.messages.noReport}</p>}
          </>
        )}
      </section>
      {report && (
        <section className="panel">
          <h2>{COPY.results.reportHeading}</h2>
          <ReportDetails report={report} />
        </section>
      )}
      {described.hasReport && !expired && (
        <section className="panel">
          <h2>{COPY.results.downloadsHeading}</h2>
          <ResultDownload id={job.job_id} diagnosticFirst={described.diagnosticOnly} attribution={hasAttribution(job)} />
        </section>
      )}
      <section className="panel">
        <h2>{COPY.results.factsHeading}</h2>
        <JobFacts job={job} pipelines={pipelines} />
        <div className="actions">
          <Link className="secondary" to="/uploads">
            {COPY.history.back}
          </Link>
          <Link className="primary" to="/uploads/new">
            {COPY.results.newUpload}
          </Link>
        </div>
      </section>
    </>
  );
}
