import assert from "node:assert/strict";
import test from "node:test";
import { bindingLabel, humanize, stoppedMessage } from "../frontend/src/uploads/display.ts";

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
