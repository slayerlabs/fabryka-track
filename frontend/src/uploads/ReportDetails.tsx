import { useState } from "react";
import { bundleGrant, type BundleKind, type UploadJob, type UploadReport } from "./api";
import { CHECK_LABELS, COPY } from "./copy";
import { bindingLabel, datasheetName, errorMessage, humanize } from "./display";
import { checksOpen, summarizeReport } from "./report";

export function ReportDetails({ report }: { report: UploadReport }) {
  const checks = report.report?.qa?.checks ?? [];
  return (
    <>
      <p>
        <strong>Verdict:</strong> {report.verdict === "failed_qa" ? COPY.verdicts.failed_qa : humanize(report.verdict)}
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
                    <td>{(check.name && CHECK_LABELS[check.name]) ?? check.name ?? "—"}</td>
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

const FILES: BundleKind[] = ["data", "metadata", "datasheet"];

export function BundleDownloads({ job, diagnostic }: { job: UploadJob; diagnostic: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download(kind: BundleKind) {
    setBusy(true);
    setError("");
    try {
      window.location.assign((await bundleGrant(job.job_id, kind, diagnostic)).url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {diagnostic && <p className="notice">{COPY.downloads.diagnosticNote}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {FILES.map((kind) => {
        const name = kind === "datasheet" ? datasheetName(job) : COPY.downloads[kind].name;
        return (
        <div className="bundle-file" key={kind}>
          <div>
            <code>{name}</code>
            <small>{COPY.downloads[kind].what}</small>
          </div>
          <button className="secondary" type="button" disabled={busy} aria-label={`${COPY.downloads.download} ${name}`} onClick={() => void download(kind)}>
            {COPY.downloads.download}
          </button>
        </div>
        );
      })}
    </>
  );
}
