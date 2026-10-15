import assert from "node:assert/strict";
import test from "node:test";
import { backTo, jobUrl, parseLocation, reachable, wizardTitle, resolveLocation, wizardUrl } from "../frontend/src/uploads/location.ts";

const params = (query) => new URLSearchParams(query);
const open = { canStart: true };
const closed = { canStart: false };

test("step, pipeline and job are read from the query string", () => {
  assert.deepEqual(parseLocation(params("step=3&pipeline=dynaword-upload&job=abc")), { step: 3, pipeline: "dynaword-upload", job: "abc" });
  assert.deepEqual(parseLocation(params("")), { step: 1, pipeline: "", job: "" });
});

test("a missing or unreadable step falls back to the first one", () => {
  for (const step of ["", "0", "5", "x", "2.5", "-1"]) assert.equal(parseLocation(params(`step=${step}`)).step, 1, step);
});

test("the URL is rebuilt from a location, leaving out empty parts", () => {
  assert.equal(wizardUrl({ step: 1, pipeline: "", job: "" }), "/uploads/new");
  assert.equal(wizardUrl({ step: 2, pipeline: "dynaword-upload", job: "" }), "/uploads/new?step=2&pipeline=dynaword-upload");
  assert.equal(wizardUrl({ step: 3, pipeline: "", job: "a b" }), "/uploads/new?step=3&job=a+b");
});

test("without a pipeline no later step is reachable", () => {
  assert.deepEqual(resolveLocation({ step: 2, pipeline: "", job: "" }, open), { step: 1, pipeline: "", job: "" });
  assert.equal(resolveLocation({ step: 3, pipeline: "", job: "" }, open).step, 1);
});

test("step 3 without a job id needs the run gate, otherwise the user goes back to step 2", () => {
  const at = { step: 3, pipeline: "p", job: "" };
  assert.equal(resolveLocation(at, open).step, 3);
  assert.equal(resolveLocation(at, closed).step, 2);
});

test("step 4 needs a job id", () => {
  assert.equal(resolveLocation({ step: 4, pipeline: "p", job: "" }, open).step, 2);
  assert.equal(resolveLocation({ step: 4, pipeline: "p", job: "" }, closed).step, 2);
  assert.equal(resolveLocation({ step: 4, pipeline: "", job: "j" }, closed).step, 4);
});

test("a job id opens step 3 or 4 directly and never needs the gate or a pipeline", () => {
  assert.deepEqual(resolveLocation({ step: 3, pipeline: "", job: "j" }, closed), { step: 3, pipeline: "", job: "j" });
  assert.equal(resolveLocation({ step: 1, pipeline: "p", job: "j" }, closed).step, 3);
  assert.equal(resolveLocation({ step: 2, pipeline: "p", job: "j" }, closed).step, 3);
});

test("history rows open step 4 for finished jobs and step 3 for jobs still working", () => {
  for (const phase of ["complete", "rejected", "expired"]) assert.equal(jobUrl({ job_id: "j", client_phase: phase }), "/uploads/new?step=4&job=j", phase);
  for (const phase of ["uploading", "validating", "queued", "running", "finalizing"]) assert.equal(jobUrl({ job_id: "j", client_phase: phase }), "/uploads/new?step=3&job=j", phase);
  assert.equal(jobUrl({ job_id: "a/b", client_phase: "running" }), "/uploads/new?step=3&job=a%2Fb");
});

test("history rows keep the job's pipeline so going back to the form knows the mode", () => {
  assert.equal(jobUrl({ job_id: "j", client_phase: "rejected", pipeline: "p" }), "/uploads/new?step=4&pipeline=p&job=j");
});

test("every earlier step is reachable from a tab and no later one is", () => {
  const cases = [
    [{ step: 4, pipeline: "p", job: "j" }, [1, 2, 3]],
    [{ step: 3, pipeline: "p", job: "j" }, [1, 2]],
    [{ step: 3, pipeline: "p", job: "" }, [1, 2]],
    [{ step: 2, pipeline: "p", job: "" }, [1]],
    [{ step: 1, pipeline: "", job: "" }, []],
  ];
  for (const [at, open] of cases)
    for (const step of [1, 2, 3, 4]) assert.equal(reachable(at, step, false), open.includes(step), `${at.step}->${step}`);
});

test("no tab is reachable while the browser is still sending the file", () => {
  for (const step of [1, 2, 3, 4]) assert.equal(reachable({ step: 3, pipeline: "p", job: "" }, step, true), false, String(step));
});

test("going back to the form or the mode leaves the job behind and keeps the pipeline", () => {
  const at = { step: 4, pipeline: "p", job: "j" };
  assert.deepEqual(backTo(at, 3), { step: 3, pipeline: "p", job: "j" });
  assert.deepEqual(backTo(at, 2), { step: 2, pipeline: "p", job: "" });
  assert.deepEqual(backTo(at, 1), { step: 1, pipeline: "p", job: "" });
  assert.equal(wizardUrl(backTo(at, 2)), "/uploads/new?step=2&pipeline=p");
  assert.deepEqual(resolveLocation(backTo(at, 2), closed), { step: 2, pipeline: "p", job: "" });
  assert.deepEqual(backTo({ step: 3, pipeline: "p", job: "j" }, 2), { step: 2, pipeline: "p", job: "" });
});

test("a job opened without its pipeline goes back to choosing the mode", () => {
  assert.equal(resolveLocation(backTo({ step: 4, pipeline: "", job: "j" }, 2), closed).step, 1);
});

test("the page title names the upload once a job id is present", () => {
  assert.equal(wizardTitle(""), "New upload");
  assert.equal(wizardTitle("7caf2e37-e453-4e31-8a5d-2e4425f606d2"), "Upload 7caf2e37");
});
