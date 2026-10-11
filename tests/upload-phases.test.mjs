import assert from "node:assert/strict";
import test from "node:test";
import { isFinal, timeline } from "../frontend/src/uploads/phases.ts";

const KEYS = ["hashing", "parts", "confirming", "validating", "queued", "running", "finalizing"];
const states = (input) => timeline(input).map((node) => node.state);
const job = (client_phase, processing_state, failure_code = null) => ({ client_phase, processing_state, failure_code });
const upload = (phase) => ({ phase, loaded: 1, total: 2 });
const P = "pending", A = "active", D = "done", F = "failed";

test("the timeline always lists the same seven nodes in order", () => {
  assert.deepEqual(timeline({}).map((node) => node.key), KEYS);
  assert.deepEqual(states({}), Array(7).fill(P));
});

test("uploader progress moves through hashing, parts and confirming", () => {
  assert.deepEqual(states({ upload: upload("hashing") }), [A, P, P, P, P, P, P]);
  assert.deepEqual(states({ upload: upload("preparing") }), [D, A, P, P, P, P, P]);
  assert.deepEqual(states({ upload: upload("uploading") }), [D, A, P, P, P, P, P]);
  assert.deepEqual(states({ upload: upload("confirming") }), [D, D, A, P, P, P, P]);
});

test("server phases mark the matching node active and the earlier ones done", () => {
  assert.deepEqual(states({ job: job("validating", "validating") }), [D, D, D, A, P, P, P]);
  assert.deepEqual(states({ job: job("queued", "queued") }), [D, D, D, D, A, P, P]);
  assert.deepEqual(states({ job: job("running", "running") }), [D, D, D, D, D, A, P]);
  assert.deepEqual(states({ job: job("running", "provisioning") }), [D, D, D, D, D, A, P]);
});

test("finalizing is not final: a passed job is still working on its last node", () => {
  assert.deepEqual(states({ job: job("finalizing", "passed") }), [D, D, D, D, D, D, A]);
  assert.deepEqual(states({ job: job("finalizing", "failed_qa", "qa_failed") }), [D, D, D, D, D, D, A]);
  assert.equal(isFinal("finalizing"), false);
});

test("complete passed and failed-quality jobs have every node done", () => {
  assert.deepEqual(states({ job: job("complete", "passed") }), Array(7).fill(D));
  assert.deepEqual(states({ job: job("complete", "failed_qa", "qa_failed") }), Array(7).fill(D));
});

test("an upload still in progress on the client wins over a job that is still uploading", () => {
  assert.deepEqual(states({ upload: upload("uploading"), job: job("uploading", "uploading") }), [D, A, P, P, P, P, P]);
  assert.deepEqual(states({ job: job("uploading", "uploading") }), [D, A, P, P, P, P, P]);
});

test("a rejected job fails at the stage that refused it and shows nothing after as done", () => {
  assert.deepEqual(states({ job: job("rejected", "rejected", "records_invalid") }), [D, D, D, F, P, P, P]);
  assert.deepEqual(states({ job: job("rejected", "rejected", "input_corrupt") }), [D, D, D, F, P, P, P]);
  assert.deepEqual(states({ job: job("finalizing", "rejected", "records_invalid") }), [D, D, D, F, P, P, P]);
});

test("a failed job fails at the running node", () => {
  for (const code of ["deadline", "memory_limit", "scratch_limit", "recipe_failed", "provider_transient", "lease_lost"])
    assert.deepEqual(states({ job: job("complete", "failed", code) }), [D, D, D, D, D, F, P], code);
  assert.deepEqual(states({ job: job("finalizing", "failed", "deadline") }), [D, D, D, D, D, F, P]);
});

test("a cancelled or expired job never shows later nodes as done", () => {
  for (const input of [
    { job: job("complete", "cancelled") },
    { job: job("expired", "uploading") },
    { job: job("expired", "validating") },
    { job: job("expired", "queued") },
    { job: job("expired", "running") },
  ]) {
    const result = states(input);
    const stopped = result.indexOf(F);
    assert.ok(stopped >= 0);
    assert.ok(result.slice(stopped + 1).every((state) => state === P));
    assert.ok(result.slice(0, stopped).every((state) => state === D));
  }
  assert.deepEqual(states({ job: job("expired", "queued") }), [D, D, D, D, F, P, P]);
  assert.deepEqual(states({ job: job("expired", "uploading") }), [D, F, P, P, P, P, P]);
});

test("a finished job whose results expired fails its last node, not an earlier one", () => {
  assert.deepEqual(states({ job: job("expired", "passed") }), [D, D, D, D, D, D, F]);
});

test("a client-side stop keeps the upload progress as the failed node", () => {
  assert.deepEqual(states({ upload: upload("uploading"), job: job("complete", "cancelled") }), [D, F, P, P, P, P, P]);
});

test("only complete, rejected and expired are final", () => {
  for (const phase of ["complete", "rejected", "expired"]) assert.equal(isFinal(phase), true);
  for (const phase of ["uploading", "validating", "queued", "running", "finalizing", "brand_new"]) assert.equal(isFinal(phase), false);
});

test("an unknown server phase shows nothing as done beyond the upload", () => {
  assert.deepEqual(states({ job: job("brand_new", "mystery") }), Array(7).fill(P));
});

test("a rejected job never shows a node after validating as done, whatever its code", () => {
  for (const code of [null, "records_invalid", "input_corrupt"])
    assert.deepEqual(states({ job: job("rejected", "rejected", code) }), [D, D, D, F, P, P, P], String(code));
  assert.deepEqual(states({ job: job("complete", "failed", "input_corrupt") }), [D, D, D, D, D, F, P]);
});

test("a retired profile stops the job before it runs", () => {
  assert.deepEqual(states({ job: job("complete", "failed", "profile_retired") }), [D, D, D, D, F, P, P]);
});
