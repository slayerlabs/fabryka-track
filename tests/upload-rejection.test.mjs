import assert from "node:assert/strict";
import test from "node:test";
import { REJECT_REASONS, rejectionMessage } from "../frontend/src/uploads/rejection.ts";

const FIELDS = {
  missing_id: "id", invalid_id: "id", duplicate_id: "id", invalid_text: "text", empty_text: "text",
  source_mismatch: "source", missing_license: "license", missing_source_ref: "source_ref", source_ref_unresolved: "source_ref",
};

test("every current reject reason has its own sentence naming the record", () => {
  const seen = new Set();
  for (const reason of REJECT_REASONS) {
    const message = rejectionMessage({ position: 7, rule: reason, field: FIELDS[reason] ?? null });
    assert.match(message, /^Record 7 /, reason);
    assert.doesNotMatch(message, /did not pass/, reason);
    assert.ok(!seen.has(message), reason);
    seen.add(message);
  }
  assert.equal(REJECT_REASONS.length, 13);
});

test("the sentences say what is wrong", () => {
  const msg = (rule, field = null) => rejectionMessage({ position: 3, rule, field });
  assert.equal(msg("unparseable"), "Record 3 is not valid JSON.");
  assert.equal(msg("not_an_object"), "Record 3 is not a JSON object.");
  assert.equal(msg("missing_id", "id"), "Record 3 has no id.");
  assert.equal(msg("invalid_id", "id"), "Record 3 has an id that is not a non-blank string or an integer.");
  assert.equal(msg("duplicate_id", "id"), "Record 3 repeats an id used by an earlier record.");
  assert.equal(msg("invalid_text", "text"), "Record 3 has a text that is not a string.");
  assert.equal(msg("empty_text", "text"), "Record 3 has a blank text.");
  assert.equal(msg("source_mismatch", "source"), "Record 3 has a source that differs from the source you entered.");
  assert.match(msg("missing_license", "license"), /^Record 3 has no license and no license was entered/);
  assert.match(msg("missing_source_ref", "source_ref"), /^Record 3 has no source_ref/);
  assert.match(msg("source_ref_unresolved", "source_ref"), /^Record 3 has a source_ref that cannot be resolved/);
});

test("a Parquet file without a required column is named by column", () => {
  assert.equal(rejectionMessage({ position: 0, rule: "parquet_column", field: "text" }), "The Parquet file has no text column.");
  assert.equal(rejectionMessage({ position: 0, rule: "parquet_column", field: "id" }), "The Parquet file has no id column.");
});

test("an unknown rule falls back to a generic sentence", () => {
  assert.equal(rejectionMessage({ position: 2, rule: "new_rule", field: "id" }), "Record 2 did not pass the new_rule check on id.");
  assert.equal(rejectionMessage({ position: 0, rule: "x", field: null }), "A record did not pass the x check.");
});
