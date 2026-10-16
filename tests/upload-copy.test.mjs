import assert from "node:assert/strict";
import test from "node:test";
import { COPY, CHECK_LABELS, PII_LABELS, REJECT_LABELS, STAGE_LABELS, STAT_LABELS } from "../frontend/src/uploads/copy.ts";
import { REJECT_REASONS, rejectionMessage } from "../frontend/src/uploads/rejection.ts";
import { timeline } from "../frontend/src/uploads/phases.ts";

function leaves(value, path = "COPY") {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, item]) => leaves(item, `${path}.${key}`));
}

test("every wizard string is present and non-blank", () => {
  const all = leaves(COPY);
  assert.ok(all.length > 20);
  for (const [path, text] of all) assert.ok(text.trim().length > 0, path);
});

test("there is a title for each of the four steps and a label for each timeline node", () => {
  assert.equal(COPY.steps.length, 4);
  for (const { key } of timeline({})) assert.ok(COPY.timeline[key], key);
});

test("verdicts and recipe stages are described", () => {
  for (const verdict of ["passed", "failed_qa"]) assert.ok(COPY.verdicts[verdict], verdict);
  assert.ok(COPY.recipeStages.length >= 3);
});

test("the report label maps are part of the copy", () => {
  assert.equal(COPY.labels.reject, REJECT_LABELS);
  assert.equal(COPY.labels.stage, STAGE_LABELS);
  assert.equal(COPY.labels.pii, PII_LABELS);
  assert.equal(COPY.labels.stat, STAT_LABELS);
  assert.equal(COPY.labels.check, CHECK_LABELS);
});

test("the Dynaword bundle checks replace attribution coverage", () => {
  assert.equal(CHECK_LABELS.attribution_coverage, undefined);
  assert.equal(CHECK_LABELS.metadata_binding, "Data and metadata match row by row");
  assert.equal(CHECK_LABELS.datasheet, "Datasheet structure");
});

test("an invalid source address is a described reject reason", () => {
  assert.ok(REJECT_REASONS.includes("invalid_source_ref"));
  assert.equal(REJECT_LABELS.invalid_source_ref, "invalid source address");
  assert.match(rejectionMessage({ position: 3, rule: "invalid_source_ref", field: "source_ref" }), /^Record 3 has a source_ref /);
});

test("no copy still promises a single result file or an attribution file", () => {
  for (const [path, text] of leaves(COPY)) {
    assert.doesNotMatch(text, /result file|attribution/i, path);
  }
});
