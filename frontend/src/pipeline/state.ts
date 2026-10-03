import type { JobStatus } from "./types.ts";

export type UploadState =
  | { phase: JobStatus["client_phase"]; status: JobStatus }
  | { phase: "idle" | "hashing" | "paused"; status: JobStatus | null };

export type TerminalView = { title: string; resultAllowed: boolean; diagnostic: boolean };

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
  const title = expired ? expiredTitle : titles[status.processing_state];
  const resultAllowed =
    !expired &&
    (status.processing_state === "passed" || diagnostic) &&
    status.publication_state === "published" &&
    status.artifacts.some((artifact) => artifact.kind === "result");
  return { title, resultAllowed, diagnostic };
}
