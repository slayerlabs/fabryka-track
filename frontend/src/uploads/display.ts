import type { UploadJob } from "./api.ts";
import type { UploadProgress } from "./uploader.ts";
import { apiError } from "../provider.ts";

export const TRANSFER_READY = "ready";
export const TRANSFER_CLOSED = "closed";
export const PROCESSING_UPLOADING = "uploading";
export const CLOSED_PHASES = new Set(["expired", "rejected"]);
export const TERMINAL_PHASES = new Set(["complete", ...CLOSED_PHASES]);

const PHASE_LABELS: Record<string, string> = {
  uploading: "Uploading",
  validating: "Validating",
  queued: "Queued",
  running: "Running",
  finalizing: "Finalizing",
  complete: "Complete",
  expired: "Expired",
  rejected: "Rejected",
};

type JobState = Pick<UploadJob, "client_phase" | "processing_state" | "publication_state" | "failure_code">;

export function humanize(code?: string | null) {
  if (!code) return "—";
  const words = code.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function bindingLabel(binding?: boolean) {
  if (binding === undefined) return "—";
  return binding ? "Required" : "Advisory";
}

export function stoppedMessage(phase: UploadProgress["phase"]) {
  return phase === "hashing" ? "Upload stopped." : "Upload stopped. The job was cancelled.";
}

export function jobOutcome(job: JobState) {
  switch (job.processing_state) {
    case "passed":
      return "Passed";
    case "failed_qa":
      return "Failed quality checks";
    case "failed":
      return job.failure_code ? `Failed (${humanize(job.failure_code)})` : "Failed";
    case "cancelled":
      return "Cancelled";
    case "rejected":
      return "Rejected";
  }
  return job.client_phase === "expired" ? "Expired" : "—";
}

export const showsReport = (job: JobState) => job.publication_state === "published";

export const diagnosticOnly = (job: JobState) => showsReport(job) && job.processing_state === "failed_qa";

export function describeJob(job: UploadJob) {
  return {
    phase: PHASE_LABELS[job.client_phase] ?? job.client_phase,
    outcome: jobOutcome(job),
    terminal: TERMINAL_PHASES.has(job.client_phase),
    hasReport: showsReport(job),
    diagnosticOnly: diagnosticOnly(job),
    updatedAt: [job.first_result_stored_at, job.admitted_at, job.upload_started_at]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1),
  };
}

export function keepPolling(error: unknown) {
  const { status } = apiError(error);
  return status === undefined || status === 429 || status >= 500;
}
