import assert from "node:assert/strict";
import test from "node:test";
import { parseStudioMode, resolveStudioMode, studioModeUrl } from "../frontend/src/pages/StudioLocation.ts";

const params = (query) => new URLSearchParams(query);

test("direct studio defaults to Beginner and forks default to Advanced", () => {
  assert.equal(resolveStudioMode(params(""), false), "beginner");
  assert.equal(resolveStudioMode(params("parent=P&checkpoint=C"), true), "advanced");
  assert.equal(resolveStudioMode(params("mode=beginner&parent=P&checkpoint=C"), true), "beginner");
  assert.equal(resolveStudioMode(params("mode=advanced"), false), "advanced");
});

test("only exact lowercase first mode values are valid", () => {
  for (const value of ["", "unknown", "Advanced", "BEGINNER"]) {
    assert.equal(parseStudioMode(params(`mode=${value}`)), null);
    assert.equal(resolveStudioMode(params(`mode=${value}`), false), "beginner");
    assert.equal(resolveStudioMode(params(`mode=${value}`), true), "advanced");
  }
  assert.equal(parseStudioMode(params("mode=advanced&mode=beginner")), "advanced");
  assert.equal(parseStudioMode(params("mode=invalid&mode=advanced")), null);
});

test("mode changes preserve forks, unrelated values, and empty identifiers without duplicate modes", () => {
  const original = params("parent=P&checkpoint=C&note=a%2Fb%20c&mode=advanced&mode=invalid");
  const beginner = new URL(studioModeUrl(original, "beginner"), "https://example.test");
  assert.equal(beginner.searchParams.getAll("mode").join(), "beginner");
  assert.equal(beginner.searchParams.get("parent"), "P");
  assert.equal(beginner.searchParams.get("checkpoint"), "C");
  assert.equal(beginner.searchParams.get("note"), "a/b c");
  const direct = new URL(studioModeUrl(beginner.searchParams, null), "https://example.test");
  assert.equal(direct.searchParams.has("mode"), false);
  assert.equal(direct.searchParams.get("parent"), "P");
  assert.equal(direct.searchParams.get("checkpoint"), "C");
  assert.equal(direct.searchParams.get("note"), "a/b c");
  const empty = new URL(studioModeUrl(params("parent=&checkpoint=&mode=invalid"), "advanced"), "https://example.test");
  assert.equal(empty.searchParams.get("parent"), "");
  assert.equal(empty.searchParams.get("checkpoint"), "");
  assert.equal(studioModeUrl(params(""), null), "/new");
  assert.equal(studioModeUrl(params("mode=advanced"), null), "/new");
});
