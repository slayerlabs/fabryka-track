import { useState } from "react";
import { formatBytes } from "./bytes";
import { COPY } from "./copy";
import type { FileCheck } from "./useFileCheck";
import { FieldError, MetadataFields } from "./MetadataFields";
import type { UploadErrors, UploadFormState } from "./form";

interface Props {
  state: UploadFormState;
  errors: UploadErrors;
  check: FileCheck;
  canRun: boolean;
  onChange: <K extends keyof UploadFormState>(key: K, value: UploadFormState[K]) => void;
  onBack: () => void;
  onRun: () => void;
}

function CheckResult({ check }: { check: FileCheck }) {
  if (check.status === "idle") return null;
  if (check.status === "checking")
    return (
      <div className="notice" role="status">
        <p>{COPY.file.checking}</p>
        <progress aria-label={COPY.file.checking} />
      </div>
    );
  if (check.status === "error")
    return (
      <p className="error" role="alert">
        {COPY.file.checkFailed} {check.message}
      </p>
    );
  const { report } = check;
  const clean = report.blocking.length === 0 && report.warnings.length === 0;
  return (
    <div className="file-check">
      <p className="muted">
        {COPY.file.format}: {report.format?.toUpperCase() ?? "—"} · {COPY.file.size}: {formatBytes(report.size)}
        {report.rows && (
          <>
            {" "}
            · {COPY.file.rows}: {report.rows.exact ? "" : `${COPY.messages.approximateRows} `}
            {report.rows.count.toLocaleString("en-US")}
          </>
        )}
      </p>
      {report.blocking.length > 0 && (
        <div className="error" role="alert">
          <strong>{COPY.file.blockingTitle}</strong>
          <ul className="finding-list">
            {report.blocking.map((finding) => (
              <li key={finding.code}>{finding.message}</li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="notice notice-warning" role="status">
          <strong>{COPY.file.warningsTitle}</strong>
          <p>{COPY.messages.warningsOnly}</p>
          <ul className="finding-list">
            {report.warnings.map((finding) => (
              <li key={finding.code}>{finding.message}</li>
            ))}
          </ul>
        </div>
      )}
      {clean && (
        <p className="notice" role="status">
          {COPY.file.passed}
        </p>
      )}
    </div>
  );
}

export function WizardFileStep({ state, errors, check, canRun, onChange, onBack, onRun }: Props) {
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const shown = Object.fromEntries(Object.entries(errors).filter(([key]) => touched.has(key) && key !== "file")) as UploadErrors;
  const set: Props["onChange"] = (key, value) => {
    setTouched((current) => new Set(current).add(key));
    onChange(key, value);
  };
  const pending = check.status === "done" && !canRun && check.report.blocking.length === 0;
  return (
    <section className="panel">
      <h2>{COPY.steps[1].title}</h2>
      <p className="muted">{COPY.file.intro}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canRun) onRun();
        }}
        noValidate
      >
        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept=".jsonl,.parquet"
            onChange={(event) => onChange("file", event.target.files?.[0] ?? null)}
          />
          {state.file && (
            <small className="muted">
              {state.file.name} · {formatBytes(state.file.size)}
            </small>
          )}
          <small className="muted">{COPY.file.formatHint}</small>
          {!state.file && <FieldError text={touched.size ? errors.file : undefined} />}
        </label>
        <CheckResult check={check} />
        <MetadataFields state={state} errors={shown} disabled={false} set={set} />
        {pending && <p className="muted">{COPY.file.missing}</p>}
        <div className="actions">
          <button className="secondary" type="button" onClick={onBack}>
            {COPY.file.back}
          </button>
          <button className="primary" type="submit" disabled={!canRun}>
            {COPY.file.run}
          </button>
        </div>
      </form>
    </section>
  );
}
