import assert from "node:assert/strict";
import test from "node:test";
import { DECLARATION_TEXT, DECLARATION_VERSION, MAX_UPLOAD_BYTES, carryForm, pipelineLimit, prefillForm, validateUpload } from "../frontend/src/uploads/form.ts";

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

test("the form survives the job coming and going, without the file or the declaration", () => {
  const fresh = { ...valid, file: null, source: "", license: "", declaration: false };
  const filled = { ...valid, author: "Ada", source_ref: "https://example.org", per_record_provenance: true };
  const kept = { ...filled, file: null, declaration: false };
  assert.deepEqual(carryForm(filled, fresh, { step: 3, pipeline: "p", job: "j" }), kept);
  assert.deepEqual(carryForm(filled, fresh, { step: 2, pipeline: "p", job: "" }), kept);
  assert.deepEqual(carryForm(filled, fresh, { step: 1, pipeline: "p", job: "" }), kept);
});

test("a new upload with no mode chosen starts from an empty form", () => {
  const fresh = { ...valid, file: null, source: "", declaration: false };
  assert.equal(carryForm(valid, fresh, { step: 1, pipeline: "", job: "" }), fresh);
});

const blank = { ...valid, file: null, source: "", added: "2026-10-15", license: "", author: "", source_ref: "", declaration: false };
const stored = { source: "old_source", added: "2026-10-02", license: "CC0-1.0", author: "Ada", source_ref: "https://example.org",
  per_record_provenance: true, mask_names: true };

test("a form opened without its session takes the job's stored parameters", () => {
  assert.deepEqual(prefillForm(blank, stored, blank), { ...blank, source: "old_source", added: "2026-10-02", license: "CC0-1.0",
    author: "Ada", source_ref: "https://example.org", per_record_provenance: true });
});

test("values already in the form win over the job's parameters", () => {
  const typed = { ...blank, source: "typed", added: "2026-01-01", per_record_provenance: true };
  const prefilled = prefillForm(typed, { ...stored, per_record_provenance: false }, blank);
  assert.equal(prefilled.source, "typed");
  assert.equal(prefilled.added, "2026-01-01");
  assert.equal(prefilled.per_record_provenance, true);
  assert.equal(prefilled.license, "CC0-1.0");
});

test("a controller that sends no parameters leaves the form as it is", () => {
  for (const parameters of [undefined, null, "source", 3])
    assert.equal(prefillForm(blank, parameters, blank), blank);
});

test("only well-typed known fields are taken from the job", () => {
  const prefilled = prefillForm(blank, { source: 7, license: ["x"], per_record_provenance: "yes", pipeline: "other",
    declaration: true, file: "x.jsonl" }, blank);
  assert.deepEqual(prefilled, blank);
});

test("going back from a job prefills the carried form, but a new upload and entering a job do not", () => {
  const prefilled = prefillForm(blank, stored, blank);
  assert.deepEqual(carryForm(blank, blank, { step: 2, pipeline: "p", job: "" }, stored), prefilled);
  assert.deepEqual(carryForm(blank, blank, { step: 1, pipeline: "p", job: "" }, stored), prefilled);
  assert.equal(carryForm(blank, blank, { step: 1, pipeline: "", job: "" }, stored), blank);
  assert.deepEqual(carryForm(blank, blank, { step: 3, pipeline: "p", job: "j" }, stored), blank);
});
