import { useState } from "react";
import { apiError } from "../provider";
import { attributionGrant, resultGrant, type UploadReport } from "./api";
import { COPY } from "./copy";
import { bindingLabel, errorMessage, humanize } from "./display";
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

interface DownloadProps {
  id: string;
  diagnosticFirst: boolean;
  attribution?: boolean;
}

export function ResultDownload({ id, diagnosticFirst, attribution = false }: DownloadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnostic, setDiagnostic] = useState(diagnosticFirst);
  async function download(grant: () => Promise<{ url: string }>) {
    setBusy(true);
    setError("");
    try {
      window.location.assign((await grant()).url);
    } catch (e) {
      if (apiError(e).code === "diagnostic_required") setDiagnostic(true);
      setError(errorMessage(e));
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
          <button className="primary" disabled={busy} onClick={() => void download(() => resultGrant(id, false))}>
            {COPY.downloads.result}
          </button>
        )}
        {diagnostic && (
          <button className="secondary" disabled={busy} onClick={() => void download(() => resultGrant(id, true))}>
            {COPY.downloads.diagnostic}
          </button>
        )}
        {attribution && (
          <button className="secondary" disabled={busy} onClick={() => void download(() => attributionGrant(id, diagnostic))}>
            {COPY.downloads.attribution}
          </button>
        )}
      </div>
    </>
  );
}
