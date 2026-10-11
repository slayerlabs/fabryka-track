import type { UploadJob } from "./api.ts";
import { stoppedMessage } from "./display.ts";
import { isFinal } from "./phases.ts";
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
}

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
};

function observe(state: ProgressState, job: UploadJob, now: number): ProgressState {
  const final = isFinal(job.client_phase);
  const admitted = Date.parse(job.admitted_at ?? "");
  return {
    ...state,
    job,
    error: "",
    upload: job.client_phase === "uploading" ? state.upload : null,
    live: state.live || !final,
    advance: state.advance || (state.live && final),
    runningSince: state.runningSince ?? (job.client_phase === "running" ? (Number.isNaN(admitted) ? now : admitted) : null),
  };
}

export function progressReducer(state: ProgressState, action: ProgressAction): ProgressState {
  switch (action.type) {
    case "upload-started":
      return { ...initialProgress, uploading: true, live: true, upload: { phase: "hashing", loaded: 0, total: action.total } };
    case "upload-progress":
      return { ...state, upload: action.progress };
    case "upload-finished":
      return { ...state, uploading: false };
    case "upload-failed":
      return {
        ...state,
        uploading: false,
        upload: null,
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

export function timelineInput({ upload, job }: Pick<ProgressState, "upload" | "job">) {
  return {
    upload: upload ?? undefined,
    job: job
      ? { client_phase: job.client_phase, processing_state: job.processing_state ?? "", failure_code: job.failure_code ?? null }
      : undefined,
  };
}
