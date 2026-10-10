import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { describeJob, humanize } from "../uploads/display.ts";
import { getReport, getUpload, type UploadJob, type UploadReport } from "../uploads/api.ts";
import {
  bytes,
  count,
  duration,
  PII_LABELS,
  REJECT_REASON_LABELS,
  STAGE_LABELS,
  STAT_LABELS,
} from "../uploads/report.ts";
import { CountBars, type BarEntry } from "../uploads/charts.tsx";
import { ReportSummary, ResultDownload, size, when } from "./Uploads.tsx";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function labeled(
  values: Record<string, number | null | undefined> | undefined,
  labels: Record<string, string>,
  prefix = "",
  lowercase = false,
): BarEntry[] {
  if (!values) return [];
  const rank = (name: string) => Object.keys(labels).indexOf(name);
  return Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, value]) => {
      const text = labels[name] ?? name;
      return { label: `${prefix}${lowercase ? text.toLowerCase() : text}`, value };
    });
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

export function StepResults({ jobId }: { jobId: string | null }) {
  const [job, setJob] = useState<UploadJob | null>(null);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    Promise.all([getUpload(jobId, controller.signal), getReport(jobId, controller.signal)]).then(
      ([nextJob, nextReport]) => {
        if (controller.signal.aborted) return;
        setJob(nextJob);
        setReport(nextReport);
        setError("");
      },
      (e) => {
        if (!controller.signal.aborted) setError(message(e));
      },
    );
    return () => controller.abort();
  }, [jobId]);

  if (!jobId) {
    return (
      <section className="panel">
        <h2>Step 4: results</h2>
        <p className="muted">Run the pipeline in step 3 first.</p>
        <div className="actions">
          <Link className="secondary" to="/uploads/new?step=3">
            Back to step 3
          </Link>
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="panel">
        <h2>Step 4: results</h2>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!job || !report) return <p className="muted">Loading results…</p>;

  const described = describeJob(job);
  const checks = useMemo(() => report.report?.qa?.checks ?? [], [report]);
  const failed = checks.filter((check) => check.status === "failed").length;
  const funnel = report.report?.report?.funnel;
  const stats = report.report?.qa?.stats;
  const masked = report.report?.report?.pii_masked;
  const counters = report.report?.counters;

  const flow: BarEntry[] = useMemo(
    () => [
      ...(typeof funnel?.rows_in === "number" ? [{ label: "Records in", value: funnel.rows_in }] : []),
      ...labeled(funnel?.rejected, REJECT_REASON_LABELS, "Rejected: "),
      ...labeled(funnel?.removed, STAGE_LABELS, "Removed: ", true),
      ...(typeof funnel?.rows_out === "number" ? [{ label: "Records out", value: funnel.rows_out }] : []),
    ],
    [funnel],
  );
  const checkBars: BarEntry[] = useMemo(
    () =>
      checks
        .filter((check): check is typeof check & { count: number } => typeof check.count === "number")
        .map((check) => ({ label: check.name ?? "check", value: check.count })),
    [checks],
  );
  const maskedBars: BarEntry[] = useMemo(
    () => [
      ...labeled(masked, PII_LABELS),
      ...(typeof masked?.records === "number" ? [{ label: "Records with a mask", value: masked.records }] : []),
    ],
    [masked],
  );
  const statBars: BarEntry[] = useMemo(() => labeled(stats, STAT_LABELS), [stats]);

  return (
    <>
      <section className="panel">
        <h2>Step 4: results</h2>
      </section>
      <Card title="Verdict">
        {report.verdict === "failed_qa" ? "Failed quality checks" : humanize(report.verdict)}
        {report.failure_code && <> · {humanize(report.failure_code)}</>}
      </Card>
      <Card title="Records">
        {typeof funnel?.rows_in === "number" || typeof funnel?.rows_out === "number"
          ? `${count(funnel?.rows_in ?? 0)} in · ${count(funnel?.rows_out ?? 0)} out`
          : `${count(report.report?.rows_in ?? 0)} in · ${count(report.report?.rows_out ?? 0)} out`}
      </Card>
      <Card title="Upload">
        {job.pipeline} · {typeof job.encoded_bytes === "number" ? size(job.encoded_bytes) : "—"} ·{" "}
        <code>{job.input_sha256 ?? "—"}</code> · {when(job.upload_started_at)}
      </Card>
      <Card title="Quality checks">
        {checks.length === 0 ? "No checks reported." : `${failed} of ${checks.length} failed`}
      </Card>
      <Card title="Duplicates & conflicts">
        {typeof stats?.exact_duplicate_pairs === "number" ||
        typeof stats?.near_duplicate_pairs === "number" ||
        typeof stats?.license_review_records === "number"
          ? `${typeof stats?.exact_duplicate_pairs === "number" ? count(stats.exact_duplicate_pairs) : "—"} exact · ${
              typeof stats?.near_duplicate_pairs === "number" ? count(stats.near_duplicate_pairs) : "—"
            } near · ${
              typeof stats?.license_review_records === "number" ? count(stats.license_review_records) : "—"
            } for licence review`
          : "No duplicate or conflict counts reported."}
      </Card>
      <Card title="Processing">
        {typeof counters?.elapsed_ms === "number" ? duration(counters.elapsed_ms) : "—"}
        {typeof counters?.input_bytes === "number" || typeof counters?.output_bytes === "number"
          ? ` · in ${typeof counters?.input_bytes === "number" ? bytes(counters.input_bytes) : "—"} / out ${
              typeof counters?.output_bytes === "number" ? bytes(counters.output_bytes) : "—"
            }`
          : ""}
      </Card>
      {flow.length > 0 && <CountBars title="Records flow" entries={flow} ariaLabel="Records flow chart" />}
      {checkBars.length > 0 && <CountBars title="Check counts" entries={checkBars} ariaLabel="Check counts chart" />}
      {maskedBars.length > 0 && (
        <CountBars title="Personal data masked" entries={maskedBars} ariaLabel="Masked personal data chart" />
      )}
      {statBars.length > 0 && (
        <CountBars title="What happened to the data" entries={statBars} ariaLabel="Statistics chart" />
      )}
      <section className="panel">
        <h2>Report</h2>
        <ReportSummary id={job.job_id} />
        <ResultDownload id={job.job_id} diagnosticFirst={described.diagnosticOnly} />
      </section>
    </>
  );
}
