import assert from "node:assert/strict";
import test from "node:test";
import { canStartUpload, fileKey } from "../frontend/src/uploads/gate.ts";

const file = (extra = {}) => ({ name: "data.jsonl", size: 100, lastModified: 1000, ...extra });
const report = (extra = {}) => ({ format: "jsonl", size: 100, blocking: [], warnings: [], rows: { count: 3, exact: true }, ...extra });
const draft = (extra = {}) => {
  const f = file();
  return { file: f, checkedFileKey: fileKey(f), report: report(), parametersValid: true, ...extra };
};

test("a checked file with valid parameters may start", () => {
  assert.equal(canStartUpload(draft()), true);
});

test("warnings do not stop a run but blocking findings do", () => {
  assert.equal(canStartUpload(draft({ report: report({ warnings: [{ code: "invalid_records", message: "x" }] }) })), true);
  assert.equal(canStartUpload(draft({ report: report({ blocking: [{ code: "size", message: "x" }] }) })), false);
});

test("invalid parameters stop a run", () => {
  assert.equal(canStartUpload(draft({ parametersValid: false })), false);
});

test("a missing file, report or check stops a run", () => {
  assert.equal(canStartUpload(draft({ file: undefined })), false);
  assert.equal(canStartUpload(draft({ report: undefined })), false);
  assert.equal(canStartUpload(draft({ checkedFileKey: undefined })), false);
});

test("a report counts only for the file it was made for", () => {
  const other = file({ name: "other.jsonl" });
  assert.equal(canStartUpload(draft({ file: other })), false);
  assert.equal(canStartUpload(draft({ file: file({ size: 101 }) })), false);
  assert.equal(canStartUpload(draft({ file: file({ lastModified: 2000 }) })), false);
  assert.equal(canStartUpload(draft({ report: report({ size: 99 }) })), false);
});

test("the key tells files apart by name, size and modification time", () => {
  assert.equal(fileKey(file()), fileKey(file()));
  for (const change of [{ name: "b.jsonl" }, { size: 5 }, { lastModified: 1 }]) assert.notEqual(fileKey(file()), fileKey(file(change)));
});
