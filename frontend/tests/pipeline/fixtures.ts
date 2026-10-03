import examples from "../../src/pipeline/contracts/upload-v1.examples.json" with { type: "json" };

export const BASE_TIME = Date.parse("2026-10-02T10:00:00Z");
export const JOB_ID = "10000000-0000-4000-8000-000000000001";
export const STORAGE = "https://storage.example.invalid/";

export function fixture<T = Record<string, unknown>>(name: string): T {
  const found = examples.fixtures.find((candidate) => candidate.name === name);
  if (!found) throw new Error("unknown fixture " + name);
  return structuredClone(found.body) as T;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
  body: string | Uint8Array | null;
  key?: string;
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
export type Fault = (request: Captured, attempt: number) => Reply | "network" | "hang" | undefined;

export class FakeBackend {
  now = BASE_TIME;
  calls: Captured[] = [];
  stored = new Map<number, Uint8Array>();
  faults: Fault[] = [];
  transferState: "pending" | "ready" = "ready";
  readyAfterPolls = 0;
  statusOverrides: Record<string, unknown> = {};
  grantTtlMs = 300000;
  etagPrefix = '"opaque-';
  confirmations = new Map<string, string>();
  size: number;
  sha: string;

  constructor(size = 1024, sha = "a".repeat(64)) {
    this.size = size;
    this.sha = sha;
  }

  session(overrides: Record<string, unknown> = {}) {
    return { ...fixture("UploadSession-valid"), job_id: JOB_ID, transfer_state: this.transferState,
      upload_started_at: iso(BASE_TIME), upload_deadline: iso(BASE_TIME + 86400000),
      encoded_bytes: this.size, input_sha256: this.sha, ...overrides };
  }

  status(overrides: Record<string, unknown> = {}) {
    return { ...fixture("JobStatus-valid"), job_id: JOB_ID, admitted: false, processing_state: "uploading",
      client_phase: "uploading", publication_state: "none", cleanup_state: "not_due",
      transfer_state: this.transferState, attempt_id: null, generation: 0, attempts_used: 0,
      admitted_at: null, job_deadline: null, first_result_stored_at: null, expires_at: null,
      failure_code: null, artifacts: [], cleanup_obligations: [], upload_started_at: iso(BASE_TIME),
      upload_deadline: iso(BASE_TIME + 86400000), input_sha256: this.sha, encoded_bytes: this.size,
      ...overrides };
  }

  error(status: number, code: string, retryable = false, headers?: Record<string, string>): Reply {
    return { status, headers, body: { ...fixture("Error-valid"), code, retryable } };
  }

  clock = () => this.now;
  sleep = async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.now += ms;
  };
  sleeps: number[] = [];

  storageCalls() {
    return this.calls.filter((call) => call.url.startsWith(STORAGE));
  }

  controlCalls() {
    return this.calls.filter((call) => !call.url.startsWith(STORAGE));
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer())
      : (init.body as string | undefined) ?? null;
    const request: Captured = { url: String(input), method: init.method ?? "GET", headers,
      credentials: init.credentials, redirect: init.redirect, body: raw,
      key: headers["idempotency-key"] };
    this.calls.push(request);
    const attempt = this.calls.filter((call) => call.url === request.url && call.method === request.method).length;
    for (const fault of this.faults) {
      const reply = fault(request, attempt);
      if (reply === "network") throw new TypeError("Failed to fetch");
      if (reply === "hang") return hang(init.signal);
      if (reply) return respond(reply);
    }
    return respond(request.url.startsWith(STORAGE) ? this.storage(request) : this.control(request));
  };

  private storage(request: Captured): Reply {
    const number = Number(new URL(request.url).searchParams.get("partNumber"));
    const body = request.body as Uint8Array;
    this.stored.set(number, body);
    return { status: 200, headers: { ETag: `${this.etagPrefix}${number}-${body.length}"` } };
  }

  private control(request: Captured): Reply {
    const path = request.url.replace(/\?.*$/, "");
    const body = typeof request.body === "string" ? JSON.parse(request.body) : undefined;
    if (request.method === "POST" && path === "/pipeline/api/jobs") return { status: 201, body: this.session() };
    if (request.method === "POST" && path.endsWith("/parts")) {
      if (this.transferState !== "ready") return this.error(409, "transfer_not_ready");
      return { status: 200, body: { ...fixture("TransferGrant-valid"), part_number: body.part_number,
        url: `${STORAGE}input?partNumber=${body.part_number}&X-Amz-Signature=synthetic`,
        expires_at: iso(this.now + this.grantTtlMs) } };
    }
    if (request.method === "POST" && path.endsWith("/confirm")) {
      const previous = this.confirmations.get(request.key ?? "");
      if (previous !== undefined && previous !== request.body) return this.error(409, "idempotency_conflict");
      this.confirmations.set(request.key ?? "", request.body as string);
      return { status: previous === undefined ? 202 : 200,
        body: this.status({ processing_state: "validating", client_phase: "validating", transfer_state: "closed" }) };
    }
    if (request.method === "GET" && path === `/pipeline/api/jobs/${JOB_ID}`) {
      if (this.transferState === "pending" && --this.readyAfterPolls <= 0) this.transferState = "ready";
      return { status: 200, body: this.status(this.statusOverrides) };
    }
    return this.error(404, "not_found");
  }
}

function respond(reply: Reply): Response {
  const headers = new Headers(reply.headers);
  if (reply.body === undefined) return new Response(null, { status: reply.status, headers });
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
}

function hang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
