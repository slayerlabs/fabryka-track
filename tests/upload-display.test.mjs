import assert from "node:assert/strict";
import test from "node:test";
import { bindingLabel, diagnosticOnly, humanize, jobOutcome, keepPolling, rejectionMessage, showsReport, stoppedMessage } from "../frontend/src/uploads/display.ts";

test("machine codes read as plain words", () => {
  assert.equal(humanize("failed_qa"), "Failed qa");
  assert.equal(humanize("passed"), "Passed");
  assert.equal(humanize(null), "—");
  assert.equal(humanize(undefined), "—");
});

test("check bindings are labelled required or advisory", () => {
  assert.equal(bindingLabel(true), "Required");
  assert.equal(bindingLabel(false), "Advisory");
  assert.equal(bindingLabel(undefined), "—");
});

test("stopping says the job was cancelled only once a job could exist", () => {
  assert.equal(stoppedMessage("hashing"), "Upload stopped.");
  for (const phase of ["preparing", "uploading", "confirming"])
    assert.equal(stoppedMessage(phase), "Upload stopped. The job was cancelled.");
});

const job = (processing_state, extra = {}) => ({ job_id: "j", client_phase: "complete", processing_state, ...extra });

test("the outcome follows the processing state, not the client phase", () => {
  assert.equal(jobOutcome(job("passed")), "Passed");
  assert.equal(jobOutcome(job("failed_qa", { failure_code: "qa_failed" })), "Failed quality checks");
  assert.equal(jobOutcome(job("failed", { failure_code: "memory_limit" })), "Failed (Memory limit)");
  assert.equal(jobOutcome(job("failed")), "Failed");
  assert.equal(jobOutcome(job("cancelled")), "Cancelled");
  assert.equal(jobOutcome(job("rejected", { client_phase: "rejected" })), "Rejected");
  assert.equal(jobOutcome(job("uploading", { client_phase: "expired" })), "Expired");
  assert.equal(jobOutcome(job("running", { client_phase: "running" })), "—");
});

test("report and downloads appear only for a published result", () => {
  assert.equal(showsReport(job("passed", { publication_state: "published" })), true);
  assert.equal(showsReport(job("cancelled", { publication_state: "none" })), false);
  assert.equal(showsReport(job("passed", { publication_state: "pending" })), false);
  assert.equal(diagnosticOnly(job("failed_qa", { publication_state: "published" })), true);
  assert.equal(diagnosticOnly(job("passed", { publication_state: "published" })), false);
  assert.equal(diagnosticOnly(job("failed_qa", { publication_state: "none" })), false);
});

test("polling continues through transient errors and stops on a permanent refusal", () => {
  const error = (statusCode) => Object.assign(new Error("x"), { statusCode });
  assert.equal(keepPolling(new TypeError("Failed to fetch")), true);
  assert.equal(keepPolling(error(502)), true);
  assert.equal(keepPolling(error(429)), true);
  assert.equal(keepPolling(error(404)), false);
  assert.equal(keepPolling(error(403)), false);
});

test("describeJob gathers the job interpretation the pages show", async () => {
  const { describeJob } = await import("../frontend/src/uploads/display.ts");
  const described = describeJob({
    job_id: "j", client_phase: "complete", processing_state: "failed_qa", publication_state: "published",
    upload_started_at: "2026-10-08T10:00:00Z", admitted_at: "2026-10-08T10:05:00Z", first_result_stored_at: null,
  });
  assert.deepEqual(described, {
    phase: "Complete", outcome: "Failed quality checks", terminal: true, hasReport: true, diagnosticOnly: true,
    updatedAt: "2026-10-08T10:05:00Z",
  });
  const running = describeJob({ job_id: "j", client_phase: "running", processing_state: "running" });
  assert.equal(running.terminal, false);
  assert.equal(running.updatedAt, undefined);
  assert.equal(describeJob({ job_id: "j", client_phase: "brand_new" }).phase, "brand_new");
});

test("a job whose every record was refused explains the usual causes", async () => {
  const { failureHint } = await import("../frontend/src/uploads/display.ts");
  assert.match(failureHint({ processing_state: "failed", failure_code: "input_corrupt" }), /No record was accepted/);
  assert.match(failureHint({ processing_state: "failed", failure_code: "input_corrupt" }), /source_ref/);
  assert.equal(failureHint({ processing_state: "failed", failure_code: "provider_transient" }), null);
  assert.equal(failureHint({ processing_state: "passed", failure_code: null }), null);
});

const rejected = (rejection) => ({ processing_state: "rejected", failure_code: "records_invalid", client_phase: "closed", rejection });
const TAIL = " No record in the first part of the file passed, so the upload was stopped before processing.";

test("each pre-check rule has a plain message", () => {
  const cases = [
    [{ position: 3, rule: "json_object", field: null }, "Record 3 is not a JSON object."],
    [{ position: 3, rule: "required", field: "text" }, "Record 3 has no text."],
    [{ position: 3, rule: "non_blank", field: "text" }, "Record 3 has an empty text."],
    [{ position: 3, rule: "field_or_parameter", field: "license" }, "Record 3 has no license. Set License in the form or add license to every record."],
    [{ position: 3, rule: "required_when_parameter", field: "source_ref" }, "Record 3 has no source_ref, which every record needs when per-record provenance is on."],
    [{ position: 0, rule: "parquet_column", field: "text" }, "The Parquet file has no text column."],
  ];
  for (const [rejection, message] of cases) assert.equal(rejectionMessage(rejected(rejection)), message + TAIL);
});

test("an unknown rule or a missing rejection falls back", () => {
  assert.equal(rejectionMessage(rejected({ position: 2, rule: "new_rule", field: "id" })), "Record 2 did not pass the new_rule check on id." + TAIL);
  assert.equal(rejectionMessage(rejected(null)), "The first records did not pass the pre-check." + TAIL);
});

test("the list says the records were invalid", () => {
  assert.equal(jobOutcome(rejected(null)), "Rejected: invalid records");
});

test("other jobs have no rejection message", () => {
  assert.equal(rejectionMessage({ processing_state: "failed", failure_code: "input_corrupt", client_phase: "closed" }), null);
});
