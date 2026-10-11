import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { COPY } from "../uploads/copy";
import { canStartUpload } from "../uploads/gate";
import { pipelineLimit, validateUpload, type UploadFormState } from "../uploads/form";
import { parseLocation, resolveLocation, wizardUrl, type Step, type WizardLocation } from "../uploads/location";
import { emptyForm } from "../uploads/MetadataFields";
import { useFileCheck } from "../uploads/useFileCheck";
import { usePipelines } from "../uploads/usePipelines";
import { WizardFileStep } from "../uploads/WizardFileStep";
import { WizardPipelineStep } from "../uploads/WizardPipelineStep";
import { WizardResultsStep } from "../uploads/WizardResultsStep";
import { WizardProgressStep } from "../uploads/WizardProgressStep";
import { HuggingFaceGate } from "../uploads/HuggingFaceGate";

const sameLocation = (a: WizardLocation, b: WizardLocation) =>
  a.step === b.step && a.pipeline === b.pipeline && a.job === b.job;

export function UploadWizardPage() {
  return (
    <HuggingFaceGate description="Send a Dynaword file to the data pipeline, follow its validation and download the report and result.">
      <UploadWizard />
    </HuggingFaceGate>
  );
}

function UploadWizard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const pipelines = usePipelines();
  const [form, setForm] = useState<UploadFormState>(emptyForm);
  const [uploading, setUploading] = useState(false);
  const [hadJob, setHadJob] = useState(false);

  const requested = parseLocation(params);
  const only = pipelines.list.length === 1 ? pipelines.list[0].pipeline : "";
  const known = (id: string) => !pipelines.loaded || pipelines.list.some((entry) => entry.pipeline === id);
  const pipelineId = requested.job ? requested.pipeline : known(requested.pipeline) ? requested.pipeline || only : "";
  const selected = pipelines.list.find((entry) => entry.pipeline === pipelineId);
  const limit = pipelineLimit(selected);

  const state = { ...form, pipeline: pipelineId };
  const validation = validateUpload(state, limit);
  const check = useFileCheck(form.file, limit);
  const canStart = canStartUpload({
    file: form.file ?? undefined,
    checkedFileKey: check.status === "done" ? check.key : undefined,
    report: check.status === "done" ? check.report : undefined,
    parametersValid: validation.form !== undefined,
  });

  const hasJob = requested.job !== "";
  if (hasJob !== hadJob) {
    setHadJob(hasJob);
    if (hadJob) setForm(emptyForm());
  }

  const at = resolveLocation({ ...requested, pipeline: pipelineId }, { canStart });
  const settled = at.job !== "" || pipelines.loaded;
  const urlStale = !sameLocation(at, requested);
  useEffect(() => {
    if (settled && urlStale) navigate(wizardUrl(at), { replace: true });
  }, [settled, urlStale, at.step, at.pipeline, at.job]);

  const go = (next: Partial<WizardLocation> & { step: Step }, replace = false) =>
    navigate(wizardUrl({ ...at, ...next }), { replace });
  const set = <K extends keyof UploadFormState>(key: K, value: UploadFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const reachable = (step: Step) => !uploading && (at.job ? at.step === 4 && step === 3 : step < at.step);

  return (
    <>
      <nav className="steps wizard-steps" aria-label="Upload steps">
        {COPY.steps.map(({ key, title }, index) => {
          const step = (index + 1) as Step;
          return (
            <button
              key={key}
              type="button"
              className={`step${step === at.step ? " active" : ""}${step < at.step ? " done" : ""}`}
              aria-current={step === at.step ? "step" : undefined}
              disabled={step !== at.step && !reachable(step)}
              onClick={() => step !== at.step && go({ step })}
            >
              <b>{step}</b>
              {title}
            </button>
          );
        })}
      </nav>
      {at.step === 1 && (
        <WizardPipelineStep pipelines={pipelines} selected={pipelineId} onChoose={(pipeline) => go({ step: 2, pipeline })} />
      )}
      {at.step === 3 && (
        <WizardProgressStep
          jobId={at.job}
          source={form.file && validation.form ? { file: form.file, form: validation.form } : null}
          pipelines={pipelines.list}
          onJobCreated={(job) => {
            setForm(emptyForm());
            go({ step: 3, job }, true);
          }}
          onBusyChange={setUploading}
          onFinished={() => go({ step: 4 })}
        />
      )}
      {at.step === 4 && <WizardResultsStep jobId={at.job} pipelines={pipelines.list} onUnfinished={() => go({ step: 3 }, true)} />}
      {at.step === 2 && (
        <WizardFileStep
          state={state}
          errors={validation.errors}
          check={check}
          canRun={canStart}
          onChange={set}
          onBack={() => go({ step: 1 })}
          onRun={() => go({ step: 3 })}
        />
      )}
    </>
  );
}
