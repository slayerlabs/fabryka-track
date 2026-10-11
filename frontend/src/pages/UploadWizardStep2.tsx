import { useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { validateUpload, type UploadErrors, type UploadFormState } from "../uploads/form.ts";
import { FieldError, MetadataFields, type MetadataValues } from "../uploads/metadata.tsx";
import { precheckFile, type PrecheckReport } from "../uploads/precheck.ts";
import { precheckFor } from "../uploads/draft.ts";
import { size } from "./Uploads.tsx";
import { WizardDraftContext } from "./UploadWizard.tsx";

function reportRows(report: PrecheckReport) {
  return (
    <>
      <p className="muted">
        {report.format ?? "unknown format"} · {size(report.size)}
      </p>
      <dl>
      {report.findings.map((finding) => (
        <div key={finding.rule}>
          <dt>
            {finding.rule}: {finding.deferred ? "server-side" : finding.ok ? "passed" : "failed"}
          </dt>
          <dd>
            {finding.detail}
            {finding.count !== undefined ? ` (${finding.count.toLocaleString("en-US")})` : ""}
          </dd>
        </div>
      ))}
      </dl>
    </>
  );
}

export function StepFileCheck({ pipeline, maxBytes }: { pipeline: string; maxBytes: number }) {
  const draft = useContext(WizardDraftContext);
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const runId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => {
    runId.current += 1;
    abort.current?.abort();
  }, []);

  if (!draft) throw new Error("StepFileCheck must render inside the wizard draft provider.");
  const { patch } = draft;
  const file = draft.draft.file;
  const checkedScope = draft.draft.precheckScope;
  const report = checkedScope?.pipeline === pipeline && checkedScope.maxBytes === maxBytes
    ? precheckFor(file, draft.draft.precheck) : null;

  const metadata: MetadataValues = {
    source: draft.draft.source,
    added: draft.draft.added,
    license: draft.draft.license,
    author: draft.draft.author,
    source_ref: draft.draft.source_ref,
    per_record_provenance: draft.draft.per_record_provenance,
    mask_names: draft.draft.mask_names,
    declaration: draft.draft.declaration,
  };
  const formState: UploadFormState = { pipeline, file: draft.draft.file, ...metadata };
  const { errors }: { errors: UploadErrors } = validateUpload(formState, maxBytes);

  useEffect(() => {
    if (!report) void checkFile(file);
    return () => {
      runId.current += 1;
      abort.current?.abort();
    };
  }, [file, pipeline, maxBytes]);

  async function checkFile(file: File | null) {
    const id = ++runId.current;
    abort.current?.abort();
    patch({ precheck: null, precheckScope: null });
    setError("");
    if (!file) {
      setChecking(false);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setChecking(true);
    try {
      const result = await precheckFile(file, controller.signal, maxBytes);
      if (id !== runId.current || controller.signal.aborted) return;
      patch({ precheck: { file, report: result }, precheckScope: { pipeline, maxBytes } });
    } catch (e) {
      if (controller.signal.aborted || id !== runId.current) return;
      setError(e instanceof Error ? e.message : "Checking the file failed. Try again.");
    } finally {
      if (id === runId.current && !controller.signal.aborted) setChecking(false);
    }
  }

  const canRun =
    !checking && draft.draft.file !== null && report !== null && report.passed && Object.keys(errors).length === 0;

  return (
    <>
      <section className="panel">
        <h2>Step 2: check the file</h2>
        <p className="muted">
          Local checks run in your browser before upload: format, size, row count and record keys
          in the first 100 nonblank JSONL rows within the sample budget. Full validation runs server-side after upload.
        </p>
        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept=".jsonl,.parquet"
            disabled={checking}
            onChange={(event) => {
              runId.current += 1;
              abort.current?.abort();
              patch({ file: event.target.files?.[0] ?? null, precheck: null, precheckScope: null });
            }}
          />
          {draft.draft.file && <small className="muted">Selected file: {draft.draft.file.name}</small>}
          <small className="muted">The format is taken from the file extension.</small>
          <FieldError text={errors.file} />
        </label>
        <MetadataFields
          values={metadata}
          errors={errors}
          disabled={checking}
          onChange={(update) => patch(update)}
        />
      </section>
      <section className="panel">
        <h2>Pre-validation report</h2>
        {checking && (
          <p className="muted" role="status">
            Checking file…
          </p>
        )}
        {!checking && !report && <p className="muted">Choose a file to see its pre-validation report.</p>}
        {!checking && report && reportRows(report)}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            className="primary"
            type="button"
            disabled={!canRun}
            onClick={() => navigate(`/uploads/new?step=3&pipeline=${encodeURIComponent(pipeline)}`)}
          >
            {checking ? "Checking…" : "Run pipeline"}
          </button>
        </div>
        {!checking && report && !report.passed && (
          <p className="error" role="alert">
            Fix the file above, then run again.
          </p>
        )}
      </section>
    </>
  );
}
