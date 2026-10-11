import assert from "node:assert/strict";
import test from "node:test";
import { initialProgress, progressReducer, timelineInput } from "../frontend/src/uploads/progress.ts";

const job = (client_phase, extra = {}) => ({ job_id: "j", pipeline: "p", client_phase, processing_state: client_phase, ...extra });
const run = (actions, start = initialProgress) => actions.reduce(progressReducer, start);
const polled = (j, now = 1000) => ({ type: "polled", job: j, now });

test("starting an upload clears the previous attempt and shows hashing", () => {
  const failed = run([{ type: "upload-started", total: 10 }, { type: "upload-failed", message: "boom", aborted: false }]);
  assert.equal(failed.error, "boom");
  const next = progressReducer(failed, { type: "upload-started", total: 20 });
  assert.equal(next.error, "");
  assert.equal(next.uploading, true);
  assert.deepEqual(next.upload, { phase: "hashing", loaded: 0, total: 20 });
});

test("progress replaces the upload state and finishing keeps it until the first poll", () => {
  const progress = { phase: "uploading", loaded: 5, total: 10 };
  const state = run([{ type: "upload-started", total: 10 }, { type: "upload-progress", progress }, { type: "upload-finished" }]);
  assert.equal(state.uploading, false);
  assert.deepEqual(state.upload, progress);
  assert.equal(progressReducer(state, polled(job("validating"))).upload, null);
});

test("a stopped upload says whether a job could exist; other failures show their message", () => {
  const started = run([{ type: "upload-started", total: 10 }]);
  assert.equal(progressReducer(started, { type: "upload-failed", message: "", aborted: true }).error, "Upload stopped.");
  const later = run([{ type: "upload-progress", progress: { phase: "uploading", loaded: 1, total: 10 } }], started);
  assert.equal(progressReducer(later, { type: "upload-failed", message: "", aborted: true }).error, "Upload stopped. The job was cancelled.");
  const failed = progressReducer(later, { type: "upload-failed", message: "No network", aborted: false });
  assert.equal(failed.error, "No network");
  assert.equal(failed.uploading, false);
  assert.equal(failed.upload, null);
});

test("a job seen in a working phase and then in a final phase advances once", () => {
  const working = run([polled(job("running"))]);
  assert.equal(working.advance, false);
  assert.equal(progressReducer(working, polled(job("complete"))).advance, true);
  for (const phase of ["rejected", "expired"]) assert.equal(progressReducer(working, polled(job(phase))).advance, true, phase);
});

test("finalizing keeps the wizard on step 3", () => {
  const state = run([polled(job("running")), polled(job("finalizing"))]);
  assert.equal(state.advance, false);
  assert.equal(state.live, true);
});

test("opening a job that is already final never advances", () => {
  assert.equal(run([polled(job("complete")), polled(job("complete"))]).advance, false);
});

test("a job that is already final on the first poll after our own upload still advances", () => {
  const state = run([{ type: "upload-started", total: 1 }, { type: "upload-finished" }, polled(job("rejected"))]);
  assert.equal(state.advance, true);
});

test("a poll error is shown and a good poll clears it", () => {
  const failed = run([polled(job("queued")), { type: "poll-failed", message: "offline" }]);
  assert.equal(failed.error, "offline");
  assert.equal(failed.job.client_phase, "queued");
  assert.equal(progressReducer(failed, polled(job("queued"))).error, "");
});

test("cancelling is busy until the answer arrives; the answer may end the job", () => {
  const busy = run([polled(job("queued")), { type: "cancel-started" }]);
  assert.equal(busy.cancelling, true);
  assert.equal(progressReducer(busy, polled(job("queued"))).cancelling, true);
  const failed = progressReducer(busy, { type: "cancel-failed", message: "no" });
  assert.deepEqual([failed.cancelling, failed.error], [false, "no"]);
  const done = progressReducer(busy, { type: "cancelled", job: job("rejected", { processing_state: "cancelled" }), now: 1 });
  assert.deepEqual([done.cancelling, done.advance], [false, true]);
});

test("the running clock starts from admission, or from the first poll when that is unknown", () => {
  const admitted = "2026-10-11T10:00:00.000Z";
  assert.equal(run([polled(job("running", { admitted_at: admitted }), 5)]).runningSince, Date.parse(admitted));
  assert.equal(run([polled(job("running"), 5)]).runningSince, 5);
  assert.equal(run([polled(job("queued"), 5)]).runningSince, null);
  assert.equal(run([polled(job("running"), 5), polled(job("running"), 9)]).runningSince, 5);
});

test("the timeline input combines browser progress and the polled job", () => {
  assert.deepEqual(timelineInput(initialProgress), { upload: undefined, job: undefined, last: undefined, uploadFailed: false });
  const state = run([polled(job("running", { failure_code: undefined }))]);
  assert.deepEqual(timelineInput(state).job, { client_phase: "running", processing_state: "running", failure_code: null });
});

test("the last live node is remembered so a cancelled job fails where it stopped", () => {
  const state = run([polled(job("running")), { type: "cancelled", job: job("rejected", { processing_state: "cancelled" }), now: 2 }]);
  assert.equal(state.last, "running");
  assert.deepEqual(timelineInput(state).last, "running");
  assert.equal(run([polled(job("queued")), polled(job("running"))]).last, "running");
});

test("upload progress also moves the last node, and a real failure keeps it marked", () => {
  const started = run([{ type: "upload-started", total: 10 }, { type: "upload-progress", progress: { phase: "uploading", loaded: 1, total: 10 } }]);
  assert.equal(started.last, "parts");
  const failed = progressReducer(started, { type: "upload-failed", message: "boom", aborted: false });
  assert.equal(failed.uploadFailed, true);
  assert.equal(timelineInput(failed).uploadFailed, true);
  const stopped = progressReducer(started, { type: "upload-failed", message: "", aborted: true });
  assert.equal(stopped.uploadFailed, false);
  assert.equal(progressReducer(failed, { type: "upload-started", total: 1 }).uploadFailed, false);
});
