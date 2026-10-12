import type { UploadJob } from "./api.ts";
import { stoppedMessage } from "./display.ts";
import { isFinal, timeline, type NodeKey } from "./phases.ts";
import type { UploadProgress } from "./uploader.ts";

export interface ProgressState {
  upload: UploadProgress | null;
  uploading: boolean;
  job: UploadJob | null;
  error: string;
  cancelling: boolean;
  live: boolean;
  advance: boolean;
  runningSince: number | null;
  last: NodeKey | null;
  uploadFailed: boolean;
  created: boolean;
}

const UPLOAD_KEY: Record<UploadProgress["phase"], NodeKey> = { hashing: "hashing", preparing: "parts", uploading: "parts", confirming: "confirming" };

export type ProgressAction =
  | { type: "upload-started"; total: number }
  | { type: "upload-progress"; progress: UploadProgress }
  | { type: "upload-finished" }
  | { type: "upload-failed"; message: string; aborted: boolean }
  | { type: "polled"; job: UploadJob; now: number }
  | { type: "poll-failed"; message: string }
  | { type: "cancel-started" }
  | { type: "cancel-failed"; message: string }
  | { type: "cancelled"; job: UploadJob; now: number };

export const initialProgress: ProgressState = {
  upload: null,
  uploading: false,
  job: null,
  error: "",
  cancelling: false,
  live: false,
  advance: false,
  runningSince: null,
  last: null,
  uploadFailed: false,
  created: false,
};

function observe(state: ProgressState, job: UploadJob, now: number): ProgressState {
  const final = isFinal(job.client_phase);
  const admitted = Date.parse(job.admitted_at ?? "");
  return {
    ...state,
    job,
    error: "",
    upload: job.client_phase === "uploading" ? state.upload : null,
    last: final ? state.last : timeline({ job: toTimelineJob(job), upload: state.upload ?? undefined }).find((node) => node.state === "active")?.key ?? state.last,
    live: state.live || !final,
    advance: state.advance || (state.live && final),
    runningSince: state.runningSince ?? (job.client_phase === "running" ? (Number.isNaN(admitted) ? now : admitted) : null),
  };
}

export const awaitingStart = (state: ProgressState, jobId: string) => !jobId && !state.uploading && !state.created;

export function progressReducer(state: ProgressState, action: ProgressAction): ProgressState {
  switch (action.type) {
    case "upload-started":
      return { ...initialProgress, uploading: true, live: true, last: "hashing", upload: { phase: "hashing", loaded: 0, total: action.total } };
    case "upload-progress":
      return { ...state, upload: action.progress, last: UPLOAD_KEY[action.progress.phase] };
    case "upload-finished":
      return { ...state, uploading: false, created: true };
    case "upload-failed":
      return {
        ...state,
        uploading: false,
        upload: null,
        uploadFailed: !action.aborted,
        error: action.aborted ? stoppedMessage(state.upload?.phase ?? "hashing") : action.message,
      };
    case "polled":
      return observe(state, action.job, action.now);
    case "poll-failed":
      return { ...state, error: action.message };
    case "cancel-started":
      return { ...state, cancelling: true, error: "" };
    case "cancel-failed":
      return { ...state, cancelling: false, error: action.message };
    case "cancelled":
      return { ...observe(state, action.job, action.now), cancelling: false };
  }
}

const toTimelineJob = (job: UploadJob) => ({
  client_phase: job.client_phase,
  processing_state: job.processing_state ?? "",
  failure_code: job.failure_code ?? null,
});

export function timelineInput({ upload, job, last, uploadFailed }: Pick<ProgressState, "upload" | "job" | "last" | "uploadFailed">) {
  return {
    upload: upload ?? undefined,
    job: job ? toTimelineJob(job) : undefined,
    last: last ?? undefined,
    uploadFailed,
  };
}
