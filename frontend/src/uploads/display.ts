import type { Rejection, UploadJob } from "./api.ts";
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

type JobState = Pick<UploadJob, "client_phase" | "processing_state" | "publication_state" | "failure_code" | "rejection">;

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
      return job.failure_code === "records_invalid" ? "Rejected: invalid records" : "Rejected";
  }
  return job.client_phase === "expired" ? "Expired" : "—";
}

export function failureHint(job: Pick<UploadJob, "processing_state" | "failure_code">) {
  if (job.processing_state !== "failed" || job.failure_code !== "input_corrupt") return null;
  return "No record was accepted. Check that every line has an id and a text, that the license is set, and that each record has its own source_ref when records carry their own provenance.";
}

const REJECTION_TAIL = " No record in the first part of the file passed, so the upload was stopped before processing.";

const FORM_LABELS: Record<string, string> = { license: "License" };

function rejectionReason({ position, rule, field }: Rejection) {
  switch (rule) {
    case "json_object":
      return `Record ${position} is not a JSON object.`;
    case "required":
      return `Record ${position} has no ${field}.`;
    case "non_blank":
      return `Record ${position} has a blank ${field}.`;
    case "field_or_parameter":
      return `Record ${position} has no ${field}. Set ${FORM_LABELS[field ?? ""] ?? field} in the form or add ${field} to every record.`;
    case "required_when_parameter":
      return `Record ${position} has no ${field}, which every record needs when 'Records carry their own provenance' is checked.`;
    case "parquet_column":
      return `The Parquet file has no ${field} column.`;
  }
  const subject = position > 0 ? `Record ${position}` : "A record";
  return `${subject} did not pass the ${rule} check${field ? ` on ${field}` : ""}.`;
}

export function rejectionMessage(job: JobState) {
  if (job.processing_state !== "rejected" || job.failure_code !== "records_invalid") return null;
  const reason = job.rejection ? rejectionReason(job.rejection) : "The first records did not pass the pre-check.";
  return reason + REJECTION_TAIL;
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
