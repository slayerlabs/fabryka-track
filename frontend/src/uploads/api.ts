import { request } from "../provider.ts";
import { Sha256 } from "./sha256.ts";
import type { UploaderDeps } from "./uploader.ts";

export interface UploadJob {
  job_id: string;
  client_phase: string;
  processing_state?: string | null;
  publication_state?: string | null;
  transfer_state?: string | null;
  failure_code?: string | null;
  upload_started_at?: string | null;
  upload_deadline?: string | null;
  admitted_at?: string | null;
  first_result_stored_at?: string | null;
  expires_at?: string | null;
  encoded_bytes?: number | null;
  input_sha256?: string | null;
}

export interface UploadCheck {
  name?: string;
  binding?: boolean;
  status?: string;
  count?: number | null;
}

export interface UploadReport {
  verdict?: string;
  failure_code?: string | null;
  report?: {
    rows_in?: number | null;
    rows_out?: number | null;
    counters?: { elapsed_ms?: number | null; input_bytes?: number | null; output_bytes?: number | null };
    qa?: { checks?: UploadCheck[]; stats?: Record<string, number | null> };
    report?: {
      funnel?: {
        rows_in?: number | null;
        rejected?: Record<string, number>;
        removed?: Record<string, number>;
        rows_out?: number | null;
      };
      pii_masked?: Record<string, number | null>;
      pii_unmeasured?: string[];
    };
  };
}

const job = (id: string) => `/api/uploads/${encodeURIComponent(id)}`;

export const listUploads = (cursor?: string | null, signal?: AbortSignal) =>
  request<{ jobs: UploadJob[]; next_cursor: string | null }>(
    "/api/uploads" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
    { signal },
  );

export const getUpload = (id: string, signal?: AbortSignal) => request<UploadJob>(job(id), { signal });

export const getReport = (id: string, signal?: AbortSignal) =>
  request<UploadReport>(`${job(id)}/report`, { signal });

export const cancelUpload = (id: string) =>
  request<UploadJob>(`${job(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ action_key: crypto.randomUUID() }),
  });

export const resultGrant = (id: string, diagnostic: boolean) =>
  request<{ url: string }>(`${job(id)}/result${diagnostic ? "?diagnostic=true" : ""}`);

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export const browserUploaderDeps = (): UploaderDeps => ({
  call: request,
  fetch: (url, init) => fetch(url, init),
  sleep,
  createHash: () => new Sha256(),
  newKey: () => crypto.randomUUID(),
});
