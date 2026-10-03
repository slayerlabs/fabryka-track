import { ApiError, type PipelineApi } from "./api.ts";
import type { JobStatus } from "./types.ts";

export const POLL_MS = 2000;
export const POLL_FAILURE_LIMIT = 3;
export const FINALIZING_LIMIT_MS = 60000;

export type UploadState =
  | { phase: JobStatus["client_phase"]; status: JobStatus }
  | { phase: "idle" | "hashing" | "paused"; status: JobStatus | null };

export type TerminalView = {
  title: string;
  resultAllowed: boolean;
  reportAllowed: boolean;
  diagnostic: boolean;
};

const titles: Record<JobStatus["processing_state"], string> = {
  uploading: "Upload in progress",
  validating: "Upload in progress",
  queued: "Upload in progress",
  provisioning: "Upload in progress",
  running: "Upload in progress",
  passed: "Upload passed",
  failed_qa: "QA failed — diagnostic only",
  failed: "Upload failed",
  cancelled: "Upload cancelled",
  rejected: "Input rejected",
};

export function fromStatus(status: JobStatus): UploadState {
  return { phase: status.client_phase, status };
}

export function terminalView(status: JobStatus): TerminalView {
  const diagnostic = status.processing_state === "failed_qa";
  const expired = status.client_phase === "expired" || status.publication_state === "expired";
  const expiredTitle = status.admitted ? "Results expired" : "Upload window expired";
  const finalizing = !expired && status.client_phase === "finalizing";
  const title = expired ? expiredTitle : finalizing ? "Finalizing…" : titles[status.processing_state];
  const published = !expired && status.publication_state === "published";
  const has = (kind: string) => status.artifacts.some((artifact) => artifact.kind === kind);
  const resultAllowed = published && (status.processing_state === "passed" || diagnostic) && has("result");
  const reportAllowed = published && has("report");
  return { title, resultAllowed, reportAllowed, diagnostic };
}

const ENDED = new Set<JobStatus["client_phase"]>(["complete", "rejected", "expired"]);
const VERDICTS = new Set<JobStatus["processing_state"]>(["passed", "failed_qa", "failed", "cancelled", "rejected"]);

export async function pollJob(api: PipelineApi, jobId: string, signal: AbortSignal,
  update: (status: JobStatus) => void): Promise<void> {
  let failures = 0;
  let finalizingSince: number | null = null;
  for (;;) {
    let status: JobStatus | null = null;
    try {
      status = await api.status(jobId, signal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof ApiError) || !error.retryable || ++failures >= POLL_FAILURE_LIMIT) throw error;
    }
    if (status) {
      update(status);
      if (ENDED.has(status.client_phase)) return;
      const now = api.now();
      finalizingSince = status.client_phase === "finalizing" ? finalizingSince ?? now : null;
      if (finalizingSince !== null && now - finalizingSince >= FINALIZING_LIMIT_MS) {
        throw new ApiError(0, "finalizing_stalled", true);
      }
      const deadline = status.admitted ? status.job_deadline : status.upload_deadline;
      if (!VERDICTS.has(status.processing_state) && deadline && now >= Date.parse(deadline)) {
        throw new ApiError(0, "deadline_passed", true);
      }
    }
    await api.sleep(POLL_MS, signal);
  }
}

const byCode: Record<string, string> = {
  empty_file: "The selected file is empty",
  file_too_large: "Input exceeds the limit",
  unsupported_format: "Unsupported file format. Use JSONL or Parquet",
  invalid_request: "Invalid input or metadata",
  input_mismatch: "The selected file does not match this upload",
  file_size_mismatch: "The selected file does not match this upload",
  network_lost: "Connection lost. Check the network, then select Retry",
  timeout: "The pipeline did not respond in time. Select Retry",
  storage_transfer_failed: "Storage transfer failed. Select Retry",
  storage_etag_missing: "Storage did not confirm the transfer. Select Retry",
  invalid_controller_response: "The pipeline sent an unexpected response",
  finalizing_stalled: "Finalizing is taking longer than expected. Select Retry to check again",
  deadline_passed: "The job passed its deadline. Select Retry to check its final state",
  report_pending: "The report is not published yet",
  result_pending: "The result is not published yet",
  no_result: "No result available",
  not_found: "Job not found",
};

const byStatus: Record<number, string> = {
  401: "Authentication required",
  403: "Request origin denied",
  409: "Operation is not available in this state",
  410: "Upload or artifact expired",
  413: "Input exceeds the limit",
  422: "Invalid input or metadata",
  429: "Pipeline capacity is full",
  502: "Pipeline temporarily unavailable",
  503: "Pipeline temporarily unavailable",
  504: "Pipeline temporarily unavailable",
};

const specific = new Set(["report_pending", "result_pending", "no_result", "not_found"]);

export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return "Unexpected error";
  if (error.status === 0 || error.status === 200 || specific.has(error.code)) {
    if (Object.hasOwn(byCode, error.code)) return byCode[error.code];
  }
  return byStatus[error.status] ?? "Unexpected error";
}
