import type { UploadProgress } from "./uploader.ts";

export type NodeKey = "hashing" | "parts" | "confirming" | "validating" | "queued" | "running" | "finalizing";
export type NodeState = "pending" | "active" | "done" | "failed";
export interface TimelineNode {
  key: NodeKey;
  state: NodeState;
}

interface TimelineJob {
  client_phase: string;
  processing_state: string;
  failure_code: string | null;
}

const KEYS: NodeKey[] = ["hashing", "parts", "confirming", "validating", "queued", "running", "finalizing"];
const PARTS = 1;
const VALIDATING = 3;
const RUNNING = 5;
const FINALIZING = 6;

const UPLOAD_NODE: Record<UploadProgress["phase"], number> = { hashing: 0, preparing: PARTS, uploading: PARTS, confirming: 2 };
const SERVER_NODE: Record<string, number> = { validating: VALIDATING, queued: 4, running: RUNNING, provisioning: RUNNING };
const FAILURE_NODE: Record<string, number> = { records_invalid: VALIDATING, profile_retired: 4 };
const WORKER_CODES = ["input_corrupt", "deadline", "memory_limit", "scratch_limit", "recipe_failed", "provider_transient", "lease_lost", "runtime_unsupported", "transfer_transient"];
const FINISHED_RUN = new Set(["passed", "failed_qa"]);
const FINAL_PHASES = new Set(["complete", "rejected", "expired"]);

export const isFinal = (clientPhase: string) => FINAL_PHASES.has(clientPhase);

function at(index: number, state: NodeState): TimelineNode[] {
  return KEYS.map((key, position) => ({ key, state: position < index ? "done" : position === index ? state : "pending" }));
}

function failedNode(job: TimelineJob, upload?: UploadProgress, last?: NodeKey) {
  if (job.processing_state === "rejected") return VALIDATING;
  const code = job.failure_code ?? "";
  const byCode = FAILURE_NODE[code] ?? (WORKER_CODES.includes(code) ? RUNNING : undefined);
  return byCode ?? (last ? KEYS.indexOf(last) : upload ? UPLOAD_NODE[upload.phase] : SERVER_NODE[job.processing_state] ?? PARTS);
}

interface TimelineInput {
  upload?: UploadProgress;
  job?: TimelineJob;
  last?: NodeKey;
  uploadFailed?: boolean;
}

export function timeline({ upload, job, last, uploadFailed }: TimelineInput): TimelineNode[] {
  if (!job && uploadFailed && last) return at(KEYS.indexOf(last), "failed");
  if (!job) return upload ? at(UPLOAD_NODE[upload.phase], "active") : at(-1, "pending");
  const { client_phase: phase } = job;
  if (phase === "uploading") return at(upload ? UPLOAD_NODE[upload.phase] : PARTS, "active");
  if (phase in SERVER_NODE) return at(SERVER_NODE[phase], "active");
  if (phase === "finalizing" || phase === "complete") {
    if (!FINISHED_RUN.has(job.processing_state)) return at(failedNode(job, upload, last), "failed");
    return phase === "finalizing" ? at(FINALIZING, "active") : at(KEYS.length, "done");
  }
  if (phase === "expired" && FINISHED_RUN.has(job.processing_state)) return at(FINALIZING, "failed");
  if (phase === "rejected" || phase === "expired") return at(failedNode(job, upload, last), "failed");
  return at(-1, "pending");
}
