import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode } from "../frontend/src/pipeline/contract.ts";
import { fromStatus, terminalView } from "../frontend/src/pipeline/state.ts";
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
  assert.equal(fromStatus(status).phase, "finalizing");
});
test("failed QA remains diagnostic", () => {
  const status = { ...job, processing_state: "failed_qa",
    client_phase: "complete", publication_state: "published", cleanup_state: "confirmed" };
  assert.equal(terminalView(status).diagnostic, true);
  assert.notEqual(terminalView(status).title, "Upload passed");
});

test("published passed result is downloadable and not diagnostic", () => {
  const view = terminalView(status({ artifacts: [result, report, manifest] }));
  assert.deepEqual(view, { title: "Upload passed", diagnostic: false, resultAllowed: true });
});

test("every contract client_phase is carried through literally", () => {
  for (const phase of ["uploading", "validating", "queued", "running", "finalizing",
    "complete", "expired", "rejected"]) {
    assert.equal(fromStatus(status({ client_phase: phase })).phase, phase);
  }
});

test("processing, publication and cleanup stay independent while finalizing", () => {
  const view = terminalView(status({ client_phase: "finalizing", publication_state: "pending",
    cleanup_state: "pending", cleanup_obligations: ["input_delete", "publication"] }));
  assert.equal(view.resultAllowed, false, "unpublished result must not be offered (report/result 409)");
  assert.equal(fromStatus(status({ client_phase: "finalizing", publication_state: "pending" })).phase,
    "finalizing");
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
  assert.equal(fromStatus(s).phase, "rejected");
  assert.deepEqual(terminalView(s), { title: "Input rejected", diagnostic: false, resultAllowed: false });
});

test("expired artifacts are explicit and never downloadable", () => {
  const s = status({ client_phase: "expired", publication_state: "expired",
    artifacts: [result, report, manifest] });
  assert.equal(fromStatus(s).phase, "expired");
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
