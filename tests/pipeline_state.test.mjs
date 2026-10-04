import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode } from "../frontend/src/pipeline/contract.ts";
import { ApiError, PipelineApi } from "../frontend/src/pipeline/api.ts";
import { FINALIZING_LIMIT_MS, POLL_MS, errorText, isSettled, pollJob, terminalView }
  from "../frontend/src/pipeline/state.ts";
import { BASE_TIME, FakeBackend, JOB_ID } from "../frontend/tests/pipeline/fixtures.ts";
const fixtures = JSON.parse(readFileSync(
  new URL("../frontend/src/pipeline/contracts/upload-v1.examples.json", import.meta.url), "utf8"));
const job = fixtures.fixtures.find((c) => c.name === "JobStatus-valid").body;
const [result] = job.artifacts;
const report = { ...result, artifact_id: "50000000-0000-4000-8000-000000000001", kind: "report" };
const manifest = { ...result, artifact_id: "40000000-0000-4000-8000-000000000001", kind: "manifest" };

const status = (overrides) => decode("JobStatus", { ...job, ...overrides });

test("passed processing with pending cleanup is finalizing", () => {
  const status = { ...job, processing_state: "passed",
    client_phase: "finalizing", publication_state: "published", cleanup_state: "pending" };
  assert.equal(terminalView(status).title, "Finalizing…");
});
test("failed QA remains diagnostic", () => {
  const status = { ...job, processing_state: "failed_qa",
    client_phase: "complete", publication_state: "published", cleanup_state: "confirmed" };
  assert.equal(terminalView(status).diagnostic, true);
  assert.notEqual(terminalView(status).title, "Upload passed");
});

test("published passed result is downloadable and not diagnostic", () => {
  const view = terminalView(status({ artifacts: [result, report, manifest] }));
  assert.deepEqual(view, { title: "Upload passed", diagnostic: false, resultAllowed: true,
    reportAllowed: true });
});

test("every contract client_phase is carried through literally", () => {
  for (const phase of ["uploading", "validating", "queued", "running", "finalizing",
    "complete", "expired", "rejected"]) {
    const s = status({ client_phase: phase });
    assert.equal(s.client_phase, phase);
    assert.equal(isSettled(s), ["complete", "expired", "rejected"].includes(phase));
  }
});

test("processing, publication and cleanup stay independent while finalizing", () => {
  const view = terminalView(status({ client_phase: "finalizing", publication_state: "pending",
    cleanup_state: "pending", cleanup_obligations: ["input_delete", "publication"] }));
  assert.equal(view.resultAllowed, false, "unpublished result must not be offered (report/result 409)");
  assert.equal(view.title, "Finalizing…");
});

test("diagnostic failed_qa result is downloadable only as diagnostic", () => {
  const view = terminalView(status({ processing_state: "failed_qa", failure_code: "qa_failed",
    artifacts: [result, report, manifest] }));
  assert.equal(view.diagnostic, true);
  assert.equal(view.resultAllowed, true);
  assert.equal(view.title, "QA failed — diagnostic only");
});

test("empty result offers no download", () => {
  const view = terminalView(status({ processing_state: "failed_qa", failure_code: "empty_result",
    artifacts: [report, manifest] }));
  assert.equal(view.diagnostic, true);
  assert.equal(view.resultAllowed, false);
  assert.notEqual(view.title, "Upload passed");
});

test("rejected input is explicit and offers nothing", () => {
  const s = status({ processing_state: "rejected", client_phase: "rejected", admitted: false,
    publication_state: "none", failure_code: "input_corrupt", artifacts: [],
    attempt_id: null, generation: 0, attempts_used: 0, admitted_at: null, job_deadline: null,
    first_result_stored_at: null, expires_at: null });
  assert.equal(isSettled(s), true);
  assert.deepEqual(terminalView(s), { title: "Input rejected", diagnostic: false, resultAllowed: false,
    reportAllowed: false });
});

test("expired artifacts are explicit and never downloadable", () => {
  const s = status({ client_phase: "expired", publication_state: "expired",
    artifacts: [result, report, manifest] });
  assert.equal(isSettled(s), true);
  const view = terminalView(s);
  assert.equal(view.resultAllowed, false);
  assert.equal(view.title, "Results expired");
});

test("expired diagnostic stays diagnostic", () => {
  const view = terminalView(status({ processing_state: "failed_qa", failure_code: "qa_failed",
    client_phase: "expired", publication_state: "expired" }));
  assert.equal(view.diagnostic, true);
  assert.equal(view.resultAllowed, false);
});

test("non-terminal processing is in progress, failed and cancelled are explicit", () => {
  assert.equal(terminalView(status({ processing_state: "running", client_phase: "running",
    publication_state: "none" })).title, "Upload in progress");
  assert.equal(terminalView(status({ processing_state: "failed", failure_code: "deadline",
    publication_state: "none", artifacts: [] })).title, "Upload failed");
  assert.equal(terminalView(status({ processing_state: "cancelled", publication_state: "none",
    artifacts: [] })).title, "Upload cancelled");
});

test("an upload window that lapsed before admission is not a result expiry", () => {
  const s = status({ client_phase: "expired", processing_state: "uploading", transfer_state: "ready",
    admitted: false, admitted_at: null, job_deadline: null, publication_state: "none",
    first_result_stored_at: null, expires_at: null, artifacts: [] });
  const view = terminalView(s);
  assert.equal(view.title, "Upload window expired");
  assert.equal(view.resultAllowed, false);
});

test("report is offered once published for any outcome, never while pending or expired", () => {
  const published = { publication_state: "published", artifacts: [report, manifest] };
  for (const processing_state of ["passed", "failed_qa", "failed"]) {
    assert.equal(terminalView(status({ ...published, processing_state })).reportAllowed, true,
      processing_state);
  }
  assert.equal(terminalView(status({ ...published, processing_state: "failed_qa",
    failure_code: "empty_result" })).reportAllowed, true);
  assert.equal(terminalView(status({ ...published, publication_state: "pending",
    client_phase: "finalizing" })).reportAllowed, false, "report_pending before publication");
  assert.equal(terminalView(status({ ...published, publication_state: "expired",
    client_phase: "expired" })).reportAllowed, false);
  assert.equal(terminalView(status({ publication_state: "published", artifacts: [result] }))
    .reportAllowed, false);
});

test("finalizing never claims a verdict before publication and cleanup resolve", () => {
  const view = terminalView(status({ processing_state: "passed", client_phase: "finalizing",
    publication_state: "pending", cleanup_state: "pending", artifacts: [result, report, manifest] }));
  assert.equal(view.title, "Finalizing…");
  assert.equal(view.resultAllowed, false);
});

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const admitted = (backend, overrides = {}) => backend.status({ admitted: true,
  admitted_at: iso(BASE_TIME), job_deadline: iso(BASE_TIME + 7200000), transfer_state: "closed",
  processing_state: "running", client_phase: "running", ...overrides });

function scripted(replies) {
  const backend = new FakeBackend();
  let index = 0;
  backend.faults.push((request) => {
    if (request.method !== "GET") return undefined;
    const next = replies[Math.min(index++, replies.length - 1)];
    return typeof next === "function" ? next(backend) : next;
  });
  const api = new PipelineApi(backend.fetch, { now: backend.clock, sleep: backend.sleep });
  return { backend, api };
}

const ok = (overrides) => (backend) => ({ status: 200, body: admitted(backend, overrides) });

test("pollJob follows the job every 2 s until complete and then stops", async () => {
  const { backend, api } = scripted([ok({ processing_state: "queued", client_phase: "queued" }), ok(),
    ok({ processing_state: "passed", client_phase: "finalizing", publication_state: "pending",
      cleanup_state: "pending" }),
    ok({ processing_state: "passed", client_phase: "complete", publication_state: "published",
      cleanup_state: "confirmed" })]);
  const seen = [];
  await pollJob(api, JOB_ID, new AbortController().signal, (s) => seen.push(s.client_phase));
  assert.deepEqual(seen, ["queued", "running", "finalizing", "complete"]);
  assert.deepEqual(backend.sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.equal(backend.controlCalls().length, 4);
});

test("pollJob ends on rejected and expired", async () => {
  for (const client_phase of ["rejected", "expired"]) {
    const { backend, api } = scripted([ok({ client_phase })]);
    await pollJob(api, JOB_ID, new AbortController().signal, () => {});
    assert.equal(backend.controlCalls().length, 1, client_phase);
  }
});

test("three consecutive lost status requests pause polling for manual retry", async () => {
  const { backend, api } = scripted(["network", ok(), "network", "network", "network", ok()]);
  await assert.rejects(pollJob(api, JOB_ID, new AbortController().signal, () => {}),
    (error) => error instanceof ApiError && error.code === "network_lost" && error.retryable);
  assert.equal(backend.controlCalls().length, 5, "a success resets the count; the third consecutive loss stops");
});

test("non-retryable status failures stop at once", async () => {
  const { backend, api } = scripted([(b) => b.error(401, "unauthorized")]);
  await assert.rejects(pollJob(api, JOB_ID, new AbortController().signal, () => {}),
    (error) => error.status === 401);
  assert.equal(backend.controlCalls().length, 1);
});

test("finalizing stops automatic polling after 60 s with an explicit retryable state", async () => {
  const { backend, api } = scripted([ok({ processing_state: "passed", client_phase: "finalizing",
    publication_state: "pending", cleanup_state: "pending" })]);
  const seen = [];
  await assert.rejects(pollJob(api, JOB_ID, new AbortController().signal, (s) => seen.push(s)),
    (error) => error.code === "finalizing_stalled" && error.retryable);
  assert.equal(seen.length, FINALIZING_LIMIT_MS / POLL_MS + 1);
  assert.ok(backend.now - BASE_TIME <= FINALIZING_LIMIT_MS);
});

test("processing past its absolute job deadline stops after one refresh", async () => {
  const { backend, api } = scripted([ok({ job_deadline: iso(BASE_TIME - 1000) })]);
  await assert.rejects(pollJob(api, JOB_ID, new AbortController().signal, () => {}),
    (error) => error.code === "deadline_passed" && error.retryable);
  assert.equal(backend.controlCalls().length, 1);
});

test("an unadmitted upload is bounded by its upload deadline", async () => {
  const { backend, api } = scripted([(b) => ({ status: 200, body: b.status({
    upload_deadline: iso(BASE_TIME - 1000) }) })]);
  await assert.rejects(pollJob(api, JOB_ID, new AbortController().signal, () => {}),
    (error) => error.code === "deadline_passed");
  assert.equal(backend.controlCalls().length, 1);
});

test("a terminal verdict is still refreshed after the processing deadline", async () => {
  const { api } = scripted([ok({ processing_state: "failed_qa", failure_code: "qa_failed",
    client_phase: "complete", publication_state: "published", cleanup_state: "confirmed",
    job_deadline: iso(BASE_TIME - 1000) })]);
  const seen = [];
  await pollJob(api, JOB_ID, new AbortController().signal, (s) => seen.push(s.client_phase));
  assert.deepEqual(seen, ["complete"]);
});

test("aborting stops polling", async () => {
  const { api } = scripted([ok()]);
  const controller = new AbortController();
  await assert.rejects(pollJob(api, JOB_ID, controller.signal, () => controller.abort()));
});

test("failure texts are fixed English, never server text", () => {
  const cases = [[401, "unauthorized", "Authentication required"], [403, "forbidden_origin", "Request origin denied"],
    [409, "invalid_state", "Operation is not available in this state"],
    [410, "expired", "Upload or artifact expired"], [413, "body_too_large", "Input exceeds the limit"],
    [422, "invalid_request", "Invalid input or metadata"], [429, "quota_exceeded", "Pipeline capacity is full"],
    [503, "provider_unavailable", "Pipeline temporarily unavailable"],
    [409, "no_result", "No result available"]];
  for (const [code, name, text] of cases) assert.equal(errorText(new ApiError(code, name, false)), text);
  assert.equal(errorText(new ApiError(0, "empty_file", false)), "The selected file is empty");
  assert.equal(errorText(new ApiError(0, "file_too_large", false)), "Input exceeds the limit");
  assert.match(errorText(new ApiError(0, "network_lost", true)), /Retry/);
  assert.equal(errorText(new Error("<b>raw server text</b>")), "Unexpected error");
  assert.equal(errorText(new ApiError(418, "<script>", false)), "Unexpected error");
});
