import type { Page, Request, Route } from "@playwright/test";
import { BASE_TIME, FakeBackend, JOB_ID, STORAGE, fixture } from "./fixtures.ts";

export type Outcome = "passed" | "failed_qa" | "empty_result" | "failed" | "expired" | "quota" | "invalid";
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export const TEST_NOW = BASE_TIME + 60000;
const APP_ORIGIN = "http://127.0.0.1:4174";
const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
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
    return this.admitted(published);
  }

  private progress(): Record<string, unknown> {
    if (!this.confirmed) return this.backend.status();
    if (this.cancelled) return this.settled();
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
      return { status: 202, body: this.admitted({ processing_state: "cancelled", client_phase: "finalizing",
        publication_state: "none", cleanup_state: "pending", ...(this.confirmed ? {} : { admitted: false,
          admitted_at: null, job_deadline: null, transfer_state: "closed" }) }) };
    }
    if (request.method === "GET" && path === job) return { status: 200, body: this.progress() };
    if (request.method === "GET" && path === `${job}/report`) return { status: 200, body: this.report() };
    if (request.method === "GET" && path === `${job}/result`) {
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

  private async control(route: Route, request: Request, url: URL) {
    const headers = await request.allHeaders();
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

  private async storage(route: Route, request: Request, url: URL) {
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
