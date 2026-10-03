import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "../frontend/src/pipeline/contract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const contracts = join(root, "frontend/src/pipeline/contracts");
const read = (name) => readFileSync(join(contracts, name));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const examples = JSON.parse(read("upload-v1.examples.json"));
const fixture = (name) => structuredClone(examples.fixtures.find((c) => c.name === name).body);
const python = [process.env.PYTHON, join(root, ".venv/bin/python"), "python3"]
  .find((candidate) => candidate && spawnSync(candidate, ["--version"]).status === 0);
const rejects = (name, body) => assert.throws(() => decode(name, body), /^Error: invalid_controller_response$/);

test("approved contract files are byte-exact copies", () => {
  assert.equal(sha256(read("upload-v1.schema.json")),
    "9ea47b3a9bf9dda1a2b709c82715a606166646d235af4449325ede102dba2deb");
  assert.equal(sha256(read("upload-v1.examples.json")),
    "5e26e684fd0fbedaff7d7d18190afc5aef4c935f12e9fc9e729410bf75cabcf4");
});

test("all 57 approved fixtures decode exactly as declared", () => {
  assert.equal(examples.fixtures.length, 57);
  for (const { name, schema, valid, body } of examples.fixtures) {
    if (valid) assert.deepEqual(decode(schema, body), body, name);
    else rejects(schema, body);
  }
});

test("date-time format is enforced beyond the Z pattern", () => {
  const grant = fixture("TransferGrant-valid");
  rejects("TransferGrant", { ...grant, expires_at: "2026-13-45T99:99:99Z" });
  const job = fixture("JobStatus-valid");
  rejects("JobStatus", { ...job, expires_at: "2026-02-30T10:00:00Z" });
});

test("uri and date formats are enforced beyond their patterns", () => {
  const grant = fixture("TransferGrant-valid");
  rejects("TransferGrant", { ...grant, url: "https://storage.example.invalid/a b" });
  const upload = fixture("CreateUpload-valid");
  rejects("CreateUpload", { ...upload, metadata: { ...upload.metadata, added: "2026-02-30" } });
});

test("closed wire bodies reject unknown fields, versions, nullability and enums", () => {
  const job = fixture("JobStatus-valid");
  rejects("JobStatus", { ...job, extra: true });
  rejects("JobStatus", { ...job, protocol: "upload-control-v2" });
  rejects("JobStatus", { ...job, artifacts: null });
  rejects("JobStatus", { ...job, client_phase: "done" });
  rejects("JobStatus", { ...job, failure_code: undefined });
  rejects("Error", { ...fixture("Error-valid"), code: "teapot" });
});

test("controller error bodies decode with fixed codes", () => {
  const error = fixture("Error-valid");
  for (const code of ["unauthorized", "quota_exceeded", "provider_unavailable", "report_pending",
    "diagnostic_required", "expired", "transfer_not_ready", "idempotency_conflict"]) {
    assert.equal(decode("Error", { ...error, code }).code, code);
  }
});

test("unknown message names are refused", () => {
  assert.throws(() => decode("Nope", {}));
});

test("generated wire types are deterministic and current", () => {
  const work = mkdtempSync(join(tmpdir(), "pipeline-types-"));
  try {
    mkdirSync(join(work, "frontend/src/pipeline"), { recursive: true });
    cpSync(contracts, join(work, "frontend/src/pipeline/contracts"), { recursive: true });
    const run = spawnSync(python, [join(root, "scripts/generate_pipeline_types.py")],
      { cwd: work, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    const generated = readFileSync(join(work, "frontend/src/pipeline/types.ts"), "utf8");
    const committed = readFileSync(join(root, "frontend/src/pipeline/types.ts"), "utf8");
    assert.equal(generated, committed);
    const defs = Object.keys(JSON.parse(read("upload-v1.schema.json")).$defs);
    for (const name of defs) assert.match(committed, new RegExp(`^export type ${name} = `, "m"));
    assert.match(committed, /^export type ErrorBody = Error;$/m);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
