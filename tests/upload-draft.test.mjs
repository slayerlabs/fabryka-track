import assert from "node:assert/strict";
import test from "node:test";
import { precheckFor } from "../frontend/src/uploads/draft.ts";

const file = () => new File(["data"], "same.jsonl", { lastModified: 123 });
const report = { format: "jsonl", size: 4, findings: [], passed: true };

test("no file or precheck returns null", () => {
  assert.equal(precheckFor(null, null), null);
  assert.equal(precheckFor(file(), null), null);
  assert.equal(precheckFor(null, { file: file(), report }), null);
});

test("the checked File returns the exact report", () => {
  const a = file();
  assert.equal(precheckFor(a, { file: a, report }), report);
});

test("a different File has no report from the previous File", () => {
  const a = file();
  const b = new File(["other data"], "other.jsonl");
  assert.equal(precheckFor(b, { file: a, report }), null);
});

test("another File cannot reuse a check even with identical metadata", () => {
  const a = file();
  const b = file();
  assert.equal(a.name, b.name);
  assert.equal(a.size, b.size);
  assert.equal(a.lastModified, b.lastModified);
  assert.equal(precheckFor(b, { file: a, report }), null);
});

test("a failed report remains the same failed report", () => {
  const a = file();
  const failed = { ...report, passed: false };
  assert.equal(precheckFor(a, { file: a, report: failed }), failed);
  assert.equal(precheckFor(a, { file: a, report: failed }).passed, false);
});
