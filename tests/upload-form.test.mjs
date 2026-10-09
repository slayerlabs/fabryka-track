import assert from "node:assert/strict";
import test from "node:test";
import { DECLARATION_TEXT, DECLARATION_VERSION, validateUpload } from "../frontend/src/uploads/form.ts";

const valid = {
  file: { name: "corpus.jsonl", size: 1024 },
  source: "my_source",
  added: "2026-10-08",
  license: "",
  author: "  ",
  source_ref: "",
  per_record_provenance: false,
  mask_names: "no",
  declaration: true,
};

test("a complete form becomes the create request with blank optional fields omitted", () => {
  const { errors, form } = validateUpload(valid);
  assert.deepEqual(errors, {});
  assert.deepEqual(form, {
    format: "jsonl",
    parameters: { source: "my_source", added: "2026-10-08", per_record_provenance: false, mask_names: false },
    declaration: { accepted: true, version: DECLARATION_VERSION },
  });
  const filled = validateUpload({ ...valid, file: { name: "x.PARQUET", size: 5 }, license: " cc-by-4.0 ",
    author: "Ada", source_ref: "https://example.org", per_record_provenance: true, mask_names: "yes" });
  assert.equal(filled.form.format, "parquet");
  assert.deepEqual(filled.form.parameters, { source: "my_source", added: "2026-10-08", license: "cc-by-4.0",
    author: "Ada", source_ref: "https://example.org", per_record_provenance: true, mask_names: true });
});

test("source must match the controller pattern", () => {
  for (const source of ["", "My_source", "_lead", "has-dash", "a".repeat(129)])
    assert.ok(validateUpload({ ...valid, source }).errors.source, source);
  assert.equal(validateUpload({ ...valid, source: "a".repeat(128) }).errors.source, undefined);
});

test("added must be a real calendar date", () => {
  for (const added of ["", "2026-13-01", "2026-02-30", "08.10.2026"])
    assert.ok(validateUpload({ ...valid, added }).errors.added, added);
});

test("mask_names needs an explicit yes or no", () => {
  const { errors, form } = validateUpload({ ...valid, mask_names: "" });
  assert.ok(errors.mask_names);
  assert.equal(form, undefined);
});

test("the declaration must be accepted", () => {
  assert.ok(validateUpload({ ...valid, declaration: false }).errors.declaration);
});

test("the file must be a non-empty JSONL or Parquet file of at most 512 MiB", () => {
  assert.ok(validateUpload({ ...valid, file: null }).errors.file);
  assert.ok(validateUpload({ ...valid, file: { name: "data.csv", size: 10 } }).errors.file);
  assert.ok(validateUpload({ ...valid, file: { name: "data.jsonl", size: 0 } }).errors.file);
  assert.ok(validateUpload({ ...valid, file: { name: "data.jsonl", size: 512 * 1024 * 1024 + 1 } }).errors.file);
  assert.equal(validateUpload({ ...valid, file: { name: "data.jsonl", size: 512 * 1024 * 1024 } }).errors.file, undefined);
});

test("the declaration uses the same spelling as the license field", () => {
  assert.match(DECLARATION_TEXT, /\blicense\b/);
  assert.doesNotMatch(DECLARATION_TEXT, /licence/);
});
