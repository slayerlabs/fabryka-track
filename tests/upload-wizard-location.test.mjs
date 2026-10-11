import assert from "node:assert/strict";
import test from "node:test";
import { parseLocation, resolveLocation, wizardUrl } from "../frontend/src/uploads/location.ts";

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
