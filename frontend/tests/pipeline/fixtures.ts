import type { Page, Request as PlaywrightRequest, Route } from "@playwright/test";
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

export type Outcome = "passed" | "failed_qa" | "empty_result" | "failed" | "expired" | "quota" | "invalid";

export const TEST_NOW = BASE_TIME + 60000;
const APP_ORIGIN = "http://127.0.0.1:4174";
const DAY = 86400000;
const STORED = BASE_TIME + 120000;
const artifact = (kind: "result" | "report" | "manifest", n: number) => ({
  ...fixture<Record<string, unknown>>("ArtifactSummary-valid"), kind,
  artifact_id: `${n}0000000-0000-4000-8000-000000000001`,
  first_stored_at: iso(STORED), expires_at: iso(STORED + 30 * DAY),
});

const verdicts: Record<string, Record<string, unknown>> = {
  passed: { processing_state: "passed", failure_code: null,
    artifacts: [artifact("result", 3), artifact("report", 5), artifact("manifest", 4)] },
  failed_qa: { processing_state: "failed_qa", failure_code: "qa_failed",
    artifacts: [artifact("result", 3), artifact("report", 5), artifact("manifest", 4)] },
  empty_result: { processing_state: "failed_qa", failure_code: "empty_result",
    artifacts: [artifact("report", 5), artifact("manifest", 4)] },
  failed: { processing_state: "failed", failure_code: "recipe_failed", artifacts: [] },
  expired: { processing_state: "passed", failure_code: null,
    artifacts: [artifact("result", 3), artifact("report", 5), artifact("manifest", 4)] },
};

export class Journey {
  backend = new FakeBackend();
  outcome: Outcome;
  confirmed = false;
  cancelled = false;
  polls = 0;
  stallCleanup = false;
  uploadExpired = false;
  resultExpired = false;
  resultGate: Promise<void> | null = null;
  unexpected: string[] = [];
  credentialLeaks: string[] = [];
  downloads: string[] = [];
  createReply: ((attempt: number) => Reply | "network" | undefined) | null = null;
  confirmReply: ((attempt: number) => Reply | "network" | undefined) | null = null;
  storageReply: ((attempt: number) => Reply | "network" | undefined) | null = null;

  constructor(outcome: Outcome) {
    this.outcome = outcome;
    this.backend.now = TEST_NOW;
    this.backend.faults.push((request, attempt) => this.script(request, attempt));
    if (outcome === "quota") {
      this.createReply = () => this.backend.error(429, "quota_exceeded", true, { "Retry-After": "120" });
    }
    if (outcome === "invalid") this.createReply = () => this.backend.error(422, "invalid_request");
  }

  confirmCalls() {
    return this.backend.controlCalls().filter((call) => call.url.endsWith("/confirm"));
  }

  createCalls() {
    return this.backend.controlCalls().filter((call) => call.method === "POST" && call.url === "/pipeline/api/jobs");
  }

  private admitted(overrides: Record<string, unknown>) {
    return this.backend.status({ admitted: true, admitted_at: iso(BASE_TIME + 30000),
      job_deadline: iso(BASE_TIME + 30000 + 7200000), transfer_state: "closed", attempt_id: null,
      generation: 0, attempts_used: 0, ...overrides });
  }

  private settled(): Record<string, unknown> {
    if (this.cancelled && !this.confirmed) {
      return this.backend.status({ processing_state: "cancelled", client_phase: "complete",
        transfer_state: "closed", cleanup_state: "confirmed" });
    }
    if (this.cancelled) {
      return this.admitted({ processing_state: "cancelled", client_phase: "complete", publication_state: "none",
        cleanup_state: "confirmed" });
    }
    const verdict = verdicts[this.outcome];
    const published = { ...verdict, client_phase: "complete", publication_state: "published",
      cleanup_state: "confirmed", attempt_id: "20000000-0000-4000-8000-000000000001", generation: 1,
      attempts_used: 1 };
    if (verdict.artifacts && (verdict.artifacts as unknown[]).length) {
      Object.assign(published, { first_result_stored_at: iso(STORED), expires_at: iso(STORED + 30 * DAY) });
    } else {
      Object.assign(published, { publication_state: "none" });
    }
    if (this.outcome === "expired") Object.assign(published, { client_phase: "expired", publication_state: "expired" });
    else if (this.stallCleanup) Object.assign(published, { client_phase: "finalizing", cleanup_state: "pending" });
    return this.admitted(published);
  }

  private progress(): Record<string, unknown> {
    if (this.uploadExpired) {
      return this.backend.status({ client_phase: "expired", transfer_state: "closed", cleanup_state: "pending" });
    }
    if (this.cancelled) return this.settled();
    if (!this.confirmed) return this.backend.status();
    this.polls += 1;
    if (this.polls === 1) return this.admitted({ processing_state: "running", client_phase: "running" });
    if (this.polls === 2) {
      return this.admitted({ ...this.settled(), client_phase: "finalizing", publication_state: "pending",
        cleanup_state: "pending", expires_at: null, first_result_stored_at: null });
    }
    return this.settled();
  }

  private report() {
    if (this.outcome === "empty_result") return { ...fixture("empty-result-report"), job_id: JOB_ID };
    const body = fixture<Record<string, any>>("JobReport-valid");
    if (this.outcome === "failed_qa") {
      body.outcome = "failed_qa";
      body.failure_code = "qa_failed";
      body.qa.passed = false;
      body.qa.binding_checks[7] = { name: "residual_pii", status: "failed", count: 1 };
      body.qa.stats.residual_pii_records = 1;
    }
    return body;
  }

  private script(request: { url: string; method: string; key?: string; body: unknown },
    attempt: number): Reply | "network" | undefined {
    const path = request.url.replace(/\?.*$/, "");
    if (request.url.startsWith(STORAGE)) return this.storageReply?.(attempt);
    if (!path.startsWith("/pipeline/api/")) return undefined;
    const job = `/pipeline/api/jobs/${JOB_ID}`;
    if (request.method === "POST" && path === "/pipeline/api/jobs") {
      const scripted = this.createReply?.(attempt);
      if (scripted) return scripted;
      const body = JSON.parse(String(request.body));
      this.backend.size = body.encoded_bytes;
      this.backend.sha = body.input_sha256;
      return undefined;
    }
    if (request.method === "POST" && path === `${job}/confirm`) {
      const scripted = this.confirmReply?.(attempt);
      this.confirmed = true;
      return scripted ?? undefined;
    }
    if (request.method === "POST" && path === `${job}/cancel`) {
      this.cancelled = true;
      return { status: 200, body: this.admitted({ processing_state: "cancelled", client_phase: "finalizing",
        publication_state: "none", cleanup_state: "pending", ...(this.confirmed ? {} : { admitted: false,
          admitted_at: null, job_deadline: null, transfer_state: "closed" }) }) };
    }
    if (request.method === "GET" && path === job) return { status: 200, body: this.progress() };
    if (request.method === "GET" && path === `${job}/report`) return { status: 200, body: this.report() };
    if (request.method === "GET" && path === `${job}/result`) {
      if (this.resultExpired) this.outcome = "expired";
      if (this.outcome === "expired") return this.backend.error(410, "expired");
      const diagnostic = new URL(request.url, APP_ORIGIN).searchParams.get("diagnostic") === "true";
      const failedQa = this.outcome === "failed_qa";
      if (failedQa && !diagnostic) return this.backend.error(409, "diagnostic_required");
      return { status: 200, body: { ...fixture("DownloadGrant-valid"), job_id: JOB_ID, diagnostic: failedQa,
        artifact: artifact("result", 3), expires_at: iso(TEST_NOW + 300000),
        url: `${STORAGE}result/${failedQa ? "diagnostic" : "passed"}?X-Amz-Signature=synthetic` } };
    }
    return undefined;
  }

  async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === APP_ORIGIN && !url.pathname.startsWith("/pipeline/api/")) return route.fallback();
    if (url.origin === APP_ORIGIN) return this.control(route, request, url);
    if (request.url().startsWith(STORAGE)) return this.storage(route, request, url);
    this.unexpected.push(request.method() + " " + url.origin);
    return route.abort("blockedbyclient");
  }

  private async control(route: Route, request: PlaywrightRequest, url: URL) {
    const headers = await request.allHeaders();
    if (url.pathname.endsWith("/result")) await this.resultGate;
    let response: Response;
    try {
      response = await this.backend.fetch(url.pathname + url.search, { method: request.method(), headers,
        body: request.postData() ?? undefined });
    } catch {
      return route.abort("internetdisconnected");
    }
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()) });
  }

  private async storage(route: Route, request: PlaywrightRequest, url: URL) {
    const cors = { "Access-Control-Allow-Origin": APP_ORIGIN, "Access-Control-Allow-Methods": "GET, PUT",
      "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Expose-Headers": "ETag" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const headers = await request.allHeaders();
    if (headers.authorization || headers.cookie) this.credentialLeaks.push(request.method() + " " + url.pathname);
    if (request.method() === "GET") {
      this.downloads.push(url.pathname);
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=\"result.parquet\"" }, body: "PAR1synthetic" });
    }
    const body = new Blob([new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0))]);
    let response: Response;
    try {
      response = await this.backend.fetch(request.url(), { method: request.method(), headers, body });
    } catch {
      return route.abort("internetdisconnected");
    }
    return route.fulfill({ status: response.status, headers: { ...cors, ...Object.fromEntries(response.headers) },
      body: Buffer.from(await response.arrayBuffer()) });
  }
}

export async function installFixtureJourney(page: Page, outcome: Outcome): Promise<Journey> {
  const journey = new Journey(outcome);
  await page.clock.setFixedTime(TEST_NOW);
  await page.context().route("**/*", (route) => journey.handle(route));
  return journey;
}
