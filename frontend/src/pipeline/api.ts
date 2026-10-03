import { decode } from "./contract.ts";
import type {
  CancelJob,
  ConfirmUpload,
  CreateUpload,
  DownloadGrant,
  ErrorBody,
  JobReport,
  JobStatus,
  PartRequest,
  TransferGrant,
  UploadSession,
} from "./types.ts";

export const PROTOCOL = "upload-control-v1" as const;
export const MAX_RETRIES = 3;
const PREFIX = "/pipeline/api/";
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSIENT = new Set([429, 502, 503, 504]);
// A longer server-requested wait is surfaced for manual retry instead of an open-ended spinner.
const MAX_WAIT_MS = 30000;

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  constructor(status: number, code: string, retryable: boolean) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type ApiOptions = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function backoff(retry: number): number {
  return Math.min(500 * 2 ** retry, 8000);
}

function retryAfter(header: string | null, now: number): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, date - now);
}

function outgoing<T>(name: string, body: T): T {
  try {
    return decode<T>(name, body);
  } catch {
    throw new ApiError(0, "invalid_request", false);
  }
}

function jobPath(jobId: string, suffix = ""): string {
  if (!JOB_ID.test(jobId)) throw new ApiError(0, "invalid_request", false);
  return "jobs/" + jobId + suffix;
}

function sameJob<T extends { job_id: string }>(jobId: string, value: T): T {
  if (value.job_id !== jobId) throw new ApiError(200, "invalid_controller_response", false);
  return value;
}

type Call = { body?: unknown; key?: string; signal?: AbortSignal };

export class PipelineApi {
  readonly transport: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly timeoutMs: number;

  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init), options: ApiOptions = {}) {
    this.transport = fetcher;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async create(body: CreateUpload, key: string, signal?: AbortSignal): Promise<UploadSession> {
    const payload = outgoing<CreateUpload>("CreateUpload", body);
    return this.request<UploadSession>("POST", "jobs", "UploadSession", { body: payload, key, signal });
  }

  async part(jobId: string, number: number, signal?: AbortSignal): Promise<TransferGrant> {
    const body = outgoing<PartRequest>("PartRequest", { protocol: PROTOCOL, part_number: number });
    const grant = await this.request<TransferGrant>("POST", jobPath(jobId, "/parts"), "TransferGrant",
      { body, signal });
    if (grant.part_number !== number) throw new ApiError(200, "invalid_controller_response", false);
    return grant;
  }

  async confirm(jobId: string, body: ConfirmUpload, key: string, signal?: AbortSignal): Promise<JobStatus> {
    const payload = outgoing<ConfirmUpload>("ConfirmUpload", body);
    return sameJob(jobId, await this.request<JobStatus>("POST", jobPath(jobId, "/confirm"), "JobStatus",
      { body: payload, key, signal }));
  }

  async status(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
    return sameJob(jobId, await this.request<JobStatus>("GET", jobPath(jobId), "JobStatus", { signal }));
  }

  async cancel(jobId: string, key: string, signal?: AbortSignal): Promise<JobStatus> {
    const body: CancelJob = { protocol: PROTOCOL };
    return sameJob(jobId, await this.request<JobStatus>("POST", jobPath(jobId, "/cancel"), "JobStatus",
      { body, key, signal }));
  }

  async report(jobId: string, signal?: AbortSignal): Promise<JobReport> {
    return sameJob(jobId, await this.request<JobReport>("GET", jobPath(jobId, "/report"), "JobReport",
      { signal }));
  }

  async result(jobId: string, diagnostic: boolean, signal?: AbortSignal): Promise<DownloadGrant> {
    const path = jobPath(jobId, "/result?diagnostic=" + (diagnostic ? "true" : "false"));
    return sameJob(jobId, await this.request<DownloadGrant>("GET", path, "DownloadGrant", { signal }));
  }

  private async request<T>(method: string, path: string, schema: string, call: Call): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["X-Pipeline-Request"] = "1";
    }
    if (call.key) headers["Idempotency-Key"] = call.key;
    for (let retry = 0; ; retry++) {
      const { status, data, after } = await this.send(method, path, headers, payload, call.signal);
      if (status >= 200 && status < 300) return this.decoded<T>(status, schema, data);
      const failure = this.failure(status, data);
      const wait = Math.max(backoff(retry), retryAfter(after, this.now()));
      if (!TRANSIENT.has(status) || retry >= MAX_RETRIES || wait > MAX_WAIT_MS) throw failure;
      await this.sleep(wait, call.signal);
    }
  }

  private async send(method: string, path: string, headers: Record<string, string>,
    payload: string | undefined, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.transport(PREFIX + path, {
        method, credentials: "same-origin", redirect: "error", cache: "no-store",
        headers, body: payload, signal: combined,
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (combined.aborted) throw error;
        data = undefined;
      }
      return { status: response.status, data, after: response.headers.get("Retry-After") };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new ApiError(0, "timeout", true);
      throw new ApiError(0, "network_lost", true);
    }
  }

  private decoded<T>(status: number, schema: string, data: unknown): T {
    try {
      return decode<T>(schema, data);
    } catch {
      throw new ApiError(status, "invalid_controller_response", false);
    }
  }

  private failure(status: number, data: unknown): ApiError {
    try {
      const body = decode<ErrorBody>("Error", data);
      return new ApiError(status, body.code, body.retryable);
    } catch {
      return new ApiError(status, "invalid_controller_response", TRANSIENT.has(status));
    }
  }
}
