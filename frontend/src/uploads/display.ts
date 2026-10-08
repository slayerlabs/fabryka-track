import type { UploadProgress } from "./uploader";

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

interface JobState {
  client_phase: string;
  processing_state?: string | null;
  publication_state?: string | null;
  failure_code?: string | null;
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

export function keepPolling(error: unknown) {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === undefined || status === 429 || status >= 500;
}
