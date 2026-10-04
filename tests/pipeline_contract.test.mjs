import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "../frontend/src/pipeline/contract.ts";
import { ApiError, PipelineApi } from "../frontend/src/pipeline/api.ts";
import { assertSameInput, createBody, detectFormat, newOperationKey, sha256File, uploadParts }
  from "../frontend/src/pipeline/transfer.ts";
import { BASE_TIME, FakeBackend, JOB_ID, STORAGE } from "../frontend/tests/pipeline/fixtures.ts";

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

test("hash is actual streamed SHA256", async () => {
  const file = new File(["abc"], "synthetic.jsonl");
  const progress = [];
  const result = await sha256File(file, new AbortController().signal, (n) => progress.push(n));
  assert.equal(result, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(progress.at(-1), 3);
});

const MiB = 1048576;
const patterned = (size) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255);
const apiFor = (backend, options = {}) =>
  new PipelineApi(backend.fetch, { now: backend.clock, sleep: backend.sleep, ...options });
const code = (expected) => (error) => error instanceof ApiError && error.code === expected;
const live = () => new AbortController().signal;

async function upload(backend, file, session = backend.session(), completed = []) {
  const progress = [];
  const body = await uploadParts(apiFor(backend), session, file, live(), (n) => progress.push(n), completed);
  return { body, progress };
}

test("streamed hash matches node crypto across 1 MiB chunks without reading the whole file", async () => {
  const bytes = patterned(3 * MiB + 5);
  const slices = [];
  class Spy extends File {
    arrayBuffer() { throw new Error("whole file read"); }
    slice(start, end) { slices.push([start, end]); return super.slice(start, end); }
  }
  const progress = [];
  const result = await sha256File(new Spy([bytes], "x.jsonl"), live(), (n) => progress.push(n));
  assert.equal(result, sha256(bytes));
  assert.deepEqual(slices.map(([a, b]) => b - a), [MiB, MiB, MiB, MiB]);
  assert.deepEqual(progress, [MiB, 2 * MiB, 3 * MiB, 3 * MiB + 5]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(sha256File(new File([bytes], "x"), aborted.signal, () => {}));
});

test("parts go directly to storage in order with opaque ETags and completed-part progress", async () => {
  const bytes = patterned(2 * 8388608 + 3);
  const backend = new FakeBackend(bytes.length, sha256(bytes));
  const { body, progress } = await upload(backend, new File([bytes], "x.jsonl"));
  assert.deepEqual(body.parts, [1, 2, 3].map((n) => ({ part_number: n,
    etag: `"opaque-${n}-${n === 3 ? 3 : 8388608}"` })));
  assert.deepEqual(decode("ConfirmUpload", body), body);
  assert.equal(body.input_sha256, sha256(bytes));
  assert.deepEqual(progress, [8388608, 16777216, bytes.length]);
  assert.deepEqual(Buffer.concat([1, 2, 3].map((n) => backend.stored.get(n))), Buffer.from(bytes));
  const control = backend.controlCalls();
  assert.deepEqual(control.map((c) => JSON.parse(c.body).part_number), [1, 2, 3]);
  for (const call of control) {
    assert.ok(call.url.startsWith("/pipeline/api/jobs/" + JOB_ID + "/parts"));
    assert.ok(call.body.length < 200, "no file bytes travel through the control plane");
  }
});

test("storage requests carry no pipeline credentials, cookies or custom headers", async () => {
  const backend = new FakeBackend(5);
  await upload(backend, new File(["hello"], "x.jsonl"));
  const storage = backend.storageCalls();
  assert.equal(storage.length, 1);
  for (const call of storage) {
    assert.equal(call.method, "PUT");
    assert.equal(call.credentials, "omit");
    assert.equal(call.redirect, "error");
    assert.deepEqual(call.headers, { "content-type": "application/octet-stream" });
  }
  for (const call of backend.controlCalls()) {
    assert.equal(call.credentials, "same-origin");
    assert.equal(call.redirect, "error");
    assert.equal(call.headers["x-pipeline-request"], "1");
  }
});

test("a storage response without ETag fails instead of confirming", async () => {
  const backend = new FakeBackend(5);
  backend.faults.push((r) => (r.url.startsWith(STORAGE) ? { status: 200 } : undefined));
  await assert.rejects(upload(backend, new File(["hello"], "x.jsonl")), code("storage_etag_missing"));
});

test("transient PUT failures retry the same part and content, capped", async () => {
  const backend = new FakeBackend(5);
  backend.faults.push((r, n) => (r.url.startsWith(STORAGE) && n <= 2 ? { status: 503 } : undefined));
  const { body } = await upload(backend, new File(["hello"], "x.jsonl"));
  const puts = backend.storageCalls();
  assert.equal(puts.length, 3);
  for (const put of puts) assert.deepEqual(Buffer.from(put.body), Buffer.from("hello"));
  assert.equal(body.parts.length, 1);

  const failing = new FakeBackend(5);
  failing.faults.push((r) => (r.url.startsWith(STORAGE) ? { status: 500 } : undefined));
  await assert.rejects(upload(failing, new File(["hello"], "x.jsonl")), code("storage_transfer_failed"));
  assert.equal(failing.storageCalls().length, 4);

  const fatal = new FakeBackend(5);
  fatal.faults.push((r) => (r.url.startsWith(STORAGE) ? { status: 400 } : undefined));
  await assert.rejects(upload(fatal, new File(["hello"], "x.jsonl")), code("storage_transfer_failed"));
  assert.equal(fatal.storageCalls().length, 1);
});

test("an expired or refused grant is renewed for the same part number and content", async () => {
  const backend = new FakeBackend(5);
  backend.grantTtlMs = 1000;
  backend.faults.push((r, n) => (r.url.startsWith(STORAGE) && n === 1 ? { status: 503 } : undefined));
  await upload(backend, new File(["hello"], "x.jsonl"));
  const grants = backend.controlCalls().filter((c) => c.url.endsWith("/parts"));
  assert.equal(grants.length, 2, "backoff passed the grant expiry, so it was renewed");
  assert.deepEqual(grants.map((c) => JSON.parse(c.body).part_number), [1, 1]);

  const refused = new FakeBackend(5);
  refused.faults.push((r, n) => (r.url.startsWith(STORAGE) && n === 1 ? { status: 403 } : undefined));
  await upload(refused, new File(["hello"], "x.jsonl"));
  assert.equal(refused.controlCalls().filter((c) => c.url.endsWith("/parts")).length, 2);
  const session = refused.session();
  assert.equal(session.upload_deadline, new Date(BASE_TIME + 86400000).toISOString().replace(".000", ""));
});

test("a stalled PUT is aborted no later than the original upload deadline", async () => {
  const backend = new FakeBackend(5);
  const session = backend.session();
  backend.now = Date.parse(session.upload_deadline) - 50;
  backend.faults.push((r) => (r.url.startsWith(STORAGE) ? "hang" : undefined));
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PUT never aborted")), 3000); });
  try {
    await assert.rejects(Promise.race([upload(backend, new File(["hello"], "x.jsonl"), session), guard]),
      code("expired"));
  } finally {
    clearTimeout(timer);
  }
  assert.equal(backend.storageCalls().length, 1);
});

test("storage network loss stops automatic retries for an explicit manual resume", async () => {
  const bytes = patterned(8388608 + 1);
  const backend = new FakeBackend(bytes.length);
  backend.faults.push((r, n) => (r.url.includes("partNumber=2") && n === 1 ? "network" : undefined));
  const completed = [];
  const file = new File([bytes], "x.jsonl");
  await assert.rejects(upload(backend, file, backend.session(), completed),
    (e) => code("network_lost")(e) && e.retryable);
  assert.deepEqual(completed.map((p) => p.part_number), [1]);
  const { body } = await upload(backend, file, backend.session(), completed);
  assert.deepEqual(body.parts.map((p) => p.part_number), [1, 2]);
  assert.equal(backend.storageCalls().filter((c) => c.url.includes("partNumber=1")).length, 1);
});

test("parts wait for transfer_state ready within the original job and deadline", async () => {
  const backend = new FakeBackend(5);
  backend.transferState = "pending";
  backend.readyAfterPolls = 2;
  const session = backend.session();
  await upload(backend, new File(["hello"], "x.jsonl"), session);
  const control = backend.controlCalls().map((c) => c.method + " " + c.url);
  assert.deepEqual(control, [`GET /pipeline/api/jobs/${JOB_ID}`, `GET /pipeline/api/jobs/${JOB_ID}`,
    `POST /pipeline/api/jobs/${JOB_ID}/parts`]);

  const late = new FakeBackend(5);
  late.transferState = "pending";
  late.readyAfterPolls = 1;
  late.faults.push((r, n) => (r.url.endsWith("/parts") && n === 1 ? late.error(409, "transfer_not_ready") : undefined));
  await upload(late, new File(["hello"], "x.jsonl"), { ...late.session(), transfer_state: "ready" });
  assert.equal(late.controlCalls().filter((c) => c.url.endsWith("/parts")).length, 2);
  assert.equal(late.controlCalls().filter((c) => c.method === "POST" && c.url.endsWith("/jobs")).length, 0);

  const never = new FakeBackend(5);
  never.transferState = "pending";
  never.readyAfterPolls = Infinity;
  await assert.rejects(upload(never, new File(["hello"], "x.jsonl")), code("expired"));
  assert.equal(never.storageCalls().length, 0);
});

test("a lapsed upload deadline or mismatched file sends no bytes", async () => {
  const backend = new FakeBackend(5);
  backend.now = BASE_TIME + 86400000;
  await assert.rejects(upload(backend, new File(["hello"], "x.jsonl")), code("expired"));
  assert.equal(backend.calls.length, 0);
  const other = new FakeBackend(6);
  await assert.rejects(upload(other, new File(["hello"], "x.jsonl")), code("file_size_mismatch"));
  assert.equal(other.calls.length, 0);
  const session = other.session();
  assert.throws(() => assertSameInput(session, new File(["hello!"], "x"), "b".repeat(64)), code("input_mismatch"));
  assert.doesNotThrow(() => assertSameInput(session, new File(["hello!"], "x"), "a".repeat(64)));
});

test("control calls use the fixed prefix, validate responses and refuse foreign job ids", async () => {
  const backend = new FakeBackend();
  const api = apiFor(backend);
  const status = await api.status(JOB_ID);
  assert.equal(status.job_id, JOB_ID);
  const [get] = backend.calls;
  assert.equal(get.url, `/pipeline/api/jobs/${JOB_ID}`);
  assert.equal(get.headers["x-pipeline-request"], undefined);
  assert.equal(get.headers["idempotency-key"], undefined);
  for (const bad of ["../worker/v1/bootstrap", "10000000-0000-4000-8000-00000000000G", JOB_ID + "/run", ""]) {
    await assert.rejects(api.status(bad), code("invalid_request"));
  }
  assert.equal(backend.calls.length, 1);
  backend.faults.push(() => ({ status: 200, body: { ...backend.status(), extra: 1 } }));
  await assert.rejects(api.status(JOB_ID), code("invalid_controller_response"));
  backend.faults.length = 0;
  const foreign = "20000000-0000-4000-8000-000000000001";
  backend.faults.push(() => ({ status: 200, body: backend.status({ job_id: foreign }) }));
  await assert.rejects(api.status(JOB_ID), code("invalid_controller_response"));
});

test("report and result routes surface pending and diagnostic contract errors", async () => {
  const backend = new FakeBackend();
  const api = apiFor(backend);
  backend.faults.push((r) => (r.url.endsWith("/report") ? backend.error(409, "report_pending") : undefined));
  backend.faults.push((r) => (r.url.includes("/result") ? backend.error(409, "diagnostic_required") : undefined));
  await assert.rejects(api.report(JOB_ID), (e) => code("report_pending")(e) && e.status === 409);
  await assert.rejects(api.result(JOB_ID, false), code("diagnostic_required"));
  await assert.rejects(api.result(JOB_ID, true), code("diagnostic_required"));
  const urls = backend.calls.map((c) => c.url);
  assert.deepEqual(urls.slice(1), [`/pipeline/api/jobs/${JOB_ID}/result?diagnostic=false`,
    `/pipeline/api/jobs/${JOB_ID}/result?diagnostic=true`]);
});

test("transient control failures retry with the same key and body, honouring Retry-After", async () => {
  const backend = new FakeBackend();
  const api = apiFor(backend);
  const create = createBody(new File(["{}"], "synthetic.jsonl"), { source: "synthetic_760", added: "2026-10-02" },
    "a".repeat(64), "jsonl");
  backend.faults.push((r, n) => (r.method === "POST" && n <= 2
    ? backend.error(n === 1 ? 429 : 503, n === 1 ? "quota_exceeded" : "provider_unavailable", true,
      { "Retry-After": "7" }) : undefined));
  const key = newOperationKey();
  const session = await api.create(create, key);
  assert.equal(session.job_id, JOB_ID);
  assert.equal(backend.calls.length, 3);
  assert.equal(new Set(backend.calls.map((c) => c.key)).size, 1);
  assert.equal(backend.calls[0].key, key);
  assert.equal(new Set(backend.calls.map((c) => c.body)).size, 1);
  assert.deepEqual(backend.sleeps, [7000, 7000]);

  const capped = new FakeBackend();
  capped.faults.push(() => capped.error(503, "provider_unavailable", true));
  await assert.rejects(apiFor(capped).create(create, key), (e) => code("provider_unavailable")(e) && e.retryable);
  assert.equal(capped.calls.length, 4);

  const long = new FakeBackend();
  long.faults.push(() => long.error(429, "quota_exceeded", true, { "Retry-After": "3600" }));
  await assert.rejects(apiFor(long).create(create, key), code("quota_exceeded"));
  assert.equal(long.calls.length, 1, "no open-ended wait");

  const denied = new FakeBackend();
  denied.faults.push(() => denied.error(401, "unauthorized"));
  await assert.rejects(apiFor(denied).create(create, key), (e) => code("unauthorized")(e) && e.status === 401);
  assert.equal(denied.calls.length, 1);
});

test("a lost confirm response is replayed manually with the same key and body", async () => {
  const backend = new FakeBackend();
  const api = apiFor(backend);
  const confirm = { protocol: "upload-control-v1", parts: [{ part_number: 1, etag: '"opaque-1"' }],
    encoded_bytes: 1024, input_sha256: "a".repeat(64) };
  const key = newOperationKey();
  let lost = true;
  backend.faults.push((r) => {
    if (!r.url.endsWith("/confirm") || !lost) return undefined;
    lost = false;
    backend.confirmations.set(r.key, r.body);
    return "network";
  });
  await assert.rejects(api.confirm(JOB_ID, confirm, key), (e) => code("network_lost")(e) && e.retryable);
  assert.equal(backend.calls.length, 1, "network loss ends automatic attempts");
  const replay = await api.confirm(JOB_ID, confirm, key);
  assert.equal(replay.processing_state, "validating");
  const duplicate = await api.confirm(JOB_ID, confirm, key);
  assert.equal(duplicate.job_id, JOB_ID);
  assert.equal(new Set(backend.calls.map((c) => c.key + c.body)).size, 1);
  await assert.rejects(api.confirm(JOB_ID, { ...confirm, encoded_bytes: 1025 }, key), code("idempotency_conflict"));
});

test("every control call is bounded by a finite timeout and the user signal", async () => {
  const backend = new FakeBackend();
  backend.faults.push(() => "hang");
  const api = apiFor(backend, { timeoutMs: 30 });
  // AbortSignal.timeout does not keep Node 22's event loop alive on its own.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(api.status(JOB_ID), (e) => code("timeout")(e) && e.retryable);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(backend.calls.length, 1);
  const user = new AbortController();
  const pending = api.status(JOB_ID, user.signal);
  user.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
});

test("the browser waits clearly longer than the proxy so its 503 and Retry-After arrive", () => {
  const proxy = readFileSync(join(root, "src/fabryka_track/pipeline.py"), "utf8");
  const proxySeconds = Number(/AsyncClient\([^)]*timeout=(\d+)\)/.exec(proxy)[1]);
  assert.equal(new PipelineApi().timeoutMs, 15000);
  assert.ok(new PipelineApi().timeoutMs >= proxySeconds * 1000 + 5000);
});

test("admission checks content, caps and metadata before create", async () => {
  const par1 = new TextEncoder().encode("PAR1");
  const parquet = new Uint8Array([...par1, 1, 2, 3, 4, 5, 6, ...par1]);
  assert.equal(await detectFormat(new File([parquet], "named.jsonl")), "parquet");
  assert.equal(await detectFormat(new File(['{"text":"x"}\n'], "named.parquet")), "jsonl");
  await assert.rejects(detectFormat(new File([par1, "not parquet"], "x.parquet")), code("unsupported_format"));
  const tar = new Uint8Array(512);
  tar.set(new TextEncoder().encode("ustar"), 257);
  const rejected = [[0x25, 0x50, 0x44, 0x46, 0x2d], [0x50, 0x4b, 3, 4], [0x50, 0x4b, 5, 6], [0x50, 0x4b, 7, 8],
    [0x1f, 0x8b, 8], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0], [0x28, 0xb5, 0x2f, 0xfd], tar];
  for (const bytes of rejected) {
    await assert.rejects(detectFormat(new File([new Uint8Array(bytes)], "x.jsonl")), code("unsupported_format"));
  }
  await assert.rejects(detectFormat(new File([], "x.jsonl")), code("empty_file"));
  const huge = { size: 536870913, slice() { throw new Error("must not read"); } };
  await assert.rejects(detectFormat(huge), code("file_too_large"));
  const limit = { size: 536870912, slice: () => new Blob(["{}"]) };
  assert.equal(await detectFormat(limit), "jsonl");

  const file = new File(["{}"], "synthetic.jsonl");
  const minimal = createBody(file, { source: "synthetic_760", added: "2026-10-02", license: "", author: undefined },
    "a".repeat(64), "jsonl");
  assert.deepEqual(minimal.metadata, { source: "synthetic_760", added: "2026-10-02" });
  assert.equal(minimal.filename, "synthetic.jsonl");
  assert.equal(createBody(new File(["{}"], "x".repeat(256)), minimal.metadata, "a".repeat(64), "jsonl").filename,
    undefined);
  for (const metadata of [{ source: "synthetic_760", added: "2026-10-02", extra: "x" },
    { source: "Bad Source", added: "2026-10-02" }, { source: "ok", added: "2026-02-30" }, { source: "ok" }]) {
    assert.throws(() => createBody(file, metadata, "a".repeat(64), "jsonl"), code("invalid_request"));
  }
  const backend = new FakeBackend();
  await assert.rejects(apiFor(backend).create({ ...minimal, encoded_bytes: 536870913 }, newOperationKey()),
    code("invalid_request"));
  assert.equal(backend.calls.length, 0);
});

test("operation keys satisfy the Idempotency-Key contract", () => {
  const key = newOperationKey();
  assert.match(key, /^[!-~]{16,128}$/);
  assert.notEqual(key, newOperationKey());
});


test("resume confirms exactly parts 1..count in order and refuses duplicates", async () => {
  const bytes = patterned(2 * 8388608 + 3);
  const backend = new FakeBackend(bytes.length, sha256(bytes));
  const { body, progress } = await upload(backend, new File([bytes], "x.jsonl"), backend.session(),
    [{ part_number: 2, etag: '"kept-2"' }]);
  assert.deepEqual(body.parts.map((p) => p.part_number), [1, 2, 3]);
  assert.equal(body.parts[1].etag, '"kept-2"');
  assert.deepEqual(backend.storageCalls().length, 2);
  assert.equal(progress[0], 8388608);

  const twice = new FakeBackend(5);
  await assert.rejects(upload(twice, new File(["hello"], "x.jsonl"), twice.session(),
    [{ part_number: 1, etag: '"a"' }, { part_number: 1, etag: '"b"' }]), code("input_mismatch"));
  assert.equal(twice.storageCalls().length, 0);
});

test("a job closed or expired during the ready wait stops promptly with its own code", async () => {
  const cancelled = new FakeBackend(5);
  cancelled.transferState = "pending";
  cancelled.readyAfterPolls = Infinity;
  cancelled.statusOverrides = { processing_state: "cancelled", client_phase: "complete", transfer_state: "closed" };
  await assert.rejects(upload(cancelled, new File(["hello"], "x.jsonl")), code("invalid_state"));
  assert.equal(cancelled.controlCalls().length, 1);

  const lapsed = new FakeBackend(5);
  lapsed.transferState = "pending";
  lapsed.readyAfterPolls = Infinity;
  lapsed.statusOverrides = { processing_state: "failed", client_phase: "expired", failure_code: "deadline",
    transfer_state: "closed" };
  await assert.rejects(upload(lapsed, new File(["hello"], "x.jsonl")), code("expired"));
});
