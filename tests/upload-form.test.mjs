import assert from "node:assert/strict";
import test from "node:test";
import { DECLARATION_TEXT, DECLARATION_VERSION, MAX_UPLOAD_BYTES, pipelineLimit, validateUpload } from "../frontend/src/uploads/form.ts";

const valid = {
  pipeline: "dynaword-upload",
  file: { name: "corpus.jsonl", size: 1024 },
  source: "my_source",
  added: "2026-10-08",
  license: " CC0-1.0 ",
  author: "  ",
  source_ref: "",
  per_record_provenance: false,
  declaration: true,
};

test("a complete form becomes the create request with blank optional fields omitted", () => {
  const { errors, form } = validateUpload(valid);
  assert.deepEqual(errors, {});
  assert.deepEqual(form, {
    pipeline: "dynaword-upload",
    format: "jsonl",
    parameters: { source: "my_source", added: "2026-10-08", license: "CC0-1.0", per_record_provenance: false, mask_names: true },
    declaration: { accepted: true, version: DECLARATION_VERSION },
  });
  const filled = validateUpload({ ...valid, file: { name: "x.PARQUET", size: 5 }, license: " cc-by-4.0 ",
    author: "Ada", source_ref: "https://example.org", per_record_provenance: true });
  assert.equal(filled.form.format, "parquet");
  assert.deepEqual(filled.form.parameters, { source: "my_source", added: "2026-10-08", license: "cc-by-4.0",
    author: "Ada", source_ref: "https://example.org", per_record_provenance: true, mask_names: true });
});

test("a mode must be chosen", () => {
  assert.ok(validateUpload({ ...valid, pipeline: "" }).errors.pipeline);
  assert.equal(validateUpload(valid).errors.pipeline, undefined);
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

test("personal names are always masked and the form has no mask_names choice", () => {
  const { errors, form } = validateUpload(valid);
  assert.equal(errors.mask_names, undefined);
  assert.equal(form.parameters.mask_names, true);
  assert.equal(validateUpload({ ...valid, mask_names: "no" }).form.parameters.mask_names, true);
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

test("a license is required, since records without one are all rejected", () => {
  for (const license of ["", "   "])
    assert.match(validateUpload({ ...valid, license }).errors.license, /license/i, JSON.stringify(license));
  assert.equal(validateUpload({ ...valid, license: "CC-BY-4.0" }).errors.license, undefined);
});

test("the file limit follows the chosen pipeline and falls back to the default", () => {
  const gib = 1024 ** 3;
  assert.equal(pipelineLimit({ max_encoded_bytes: 10 * gib }), 10 * gib);
  for (const pipeline of [undefined, {}, { max_encoded_bytes: 0 }, { max_encoded_bytes: "big" }])
    assert.equal(pipelineLimit(pipeline), MAX_UPLOAD_BYTES);
  const big = { ...valid, file: { name: "data.jsonl", size: 2 * gib } };
  assert.match(validateUpload(big).errors.file, /larger than 512\.0 MiB/);
  assert.equal(validateUpload(big, 10 * gib).errors.file, undefined);
  assert.match(validateUpload({ ...big, file: { name: "data.jsonl", size: 10 * gib + 1 } }, 10 * gib).errors.file, /larger than 10\.0 GiB/);
});
