import { isFinal } from "./phases.ts";

export type Step = 1 | 2 | 3 | 4;

export interface WizardLocation {
  step: Step;
  pipeline: string;
  job: string;
}

const STEPS: Step[] = [1, 2, 3, 4];

export function parseLocation(params: URLSearchParams): WizardLocation {
  const step = STEPS.find((candidate) => String(candidate) === params.get("step")) ?? 1;
  return { step, pipeline: params.get("pipeline") ?? "", job: params.get("job") ?? "" };
}

export function wizardUrl({ step, pipeline, job }: WizardLocation) {
  const params = new URLSearchParams();
  if (step > 1) params.set("step", String(step));
  if (pipeline) params.set("pipeline", pipeline);
  if (job) params.set("job", job);
  const query = params.toString();
  return query ? `/uploads/new?${query}` : "/uploads/new";
}

export function resolveLocation(at: WizardLocation, { canStart }: { canStart: boolean }): WizardLocation {
  if (at.job) return { ...at, step: at.step === 4 ? 4 : 3 };
  if (!at.pipeline) return { ...at, step: 1 };
  if (at.step === 3 && canStart) return at;
  return { ...at, step: at.step === 1 ? 1 : 2 };
}

export const reachable = (at: WizardLocation, step: Step, uploading: boolean) => !uploading && step < at.step;

// steps 1 and 2 start a new upload, so the old job stays where it is
export const backTo = (at: WizardLocation, step: Step): WizardLocation => ({ ...at, step, job: step > 2 ? at.job : "" });

export const jobUrl = ({ job_id, client_phase, pipeline = "" }: { job_id: string; client_phase: string; pipeline?: string }) =>
  wizardUrl({ step: isFinal(client_phase) ? 4 : 3, pipeline, job: job_id });

export const wizardTitle = (job: string) => (job ? `Upload ${job.slice(0, 8)}` : "New upload");
