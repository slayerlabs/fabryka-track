import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { Sha256 } from "../frontend/src/uploads/sha256.ts";
import { uploadFile } from "../frontend/src/uploads/uploader.ts";

const MiB = 1024 * 1024;
const JOB = "6f1c1f3e-2b7a-4d5e-9c3b-1a2b3c4d5e6f";

function sliceOnlyFile(bytes, name = "data.jsonl") {
  const slices = [];
  return {
    name,
    size: bytes.length,
    slices,
    slice(start, end) {
      slices.push([start, end]);
      return new Blob([bytes.subarray(start, end)]);
    },
  };
}

function fakeTrack({ readyAfter = 2, failPuts = {}, statusAfterConfirm = null } = {}) {
  const calls = [];
  const puts = [];
  let polls = 0;
  let grants = 0;
  const call = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? "GET", body });
    if (path === "/api/uploads" && init.method === "POST")
      return { job_id: JOB, transfer_state: "pending", part_size_bytes: 8 * MiB };
    if (path === `/api/uploads/${JOB}`) {
      polls++;
      return { job_id: JOB, client_phase: "uploading", processing_state: "uploading",
               transfer_state: polls > readyAfter ? "ready" : "pending", ...(statusAfterConfirm && calls.some((c) => c.path.endsWith("/confirm")) ? statusAfterConfirm : {}) };
    }
    if (path === `/api/uploads/${JOB}/parts`) {
      if (polls <= readyAfter) throw Object.assign(new Error("not ready"), { statusCode: 409 });
      grants++;
      return { method: "PUT", url: `https://bucket.test/part-${body.part_number}?grant=${grants}`, part_number: body.part_number };
    }
    if (path.endsWith("/confirm") || path.endsWith("/cancel")) return { job_id: JOB };
    throw new Error("unexpected " + path);
  };
  const fetch = async (url, init) => {
    const part = Number(new URL(url).pathname.split("-")[1]);
    const bytes = new Uint8Array(await init.body.arrayBuffer());
    puts.push({ url, part, method: init.method, bytes: bytes.length });
    if (failPuts[part] > 0) {
      failPuts[part]--;
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } });
  };
  return { calls, puts, call, fetch };
}

function deps(track, extra = {}) {
  let key = 0;
  return {
    call: track.call,
    fetch: track.fetch,
    sleep: async () => {},
    createHash: () => new Sha256(),
    newKey: () => `action-key-${String(++key).padStart(8, "0")}`,
    ...extra,
  };
}

const form = {
  pipeline: "dynaword-upload",
  format: "jsonl",
  parameters: { source: "my_source", added: "2026-10-08", mask_names: true },
  declaration: { accepted: true, version: "upload-declaration-v0-placeholder" },
};

test("a file is hashed, created, waited on, uploaded in 8 MiB parts and confirmed in order", async () => {
  const bytes = randomBytes(17 * MiB + 5);
  const file = sliceOnlyFile(bytes);
  const track = fakeTrack();
  const progress = [];
  const jobId = await uploadFile(file, form, deps(track), { onProgress: (p) => progress.push(p) });
  assert.equal(jobId, JOB);

  const create = track.calls[0];
  assert.equal(create.path, "/api/uploads");
  assert.deepEqual(create.body.input, {
    format: "jsonl", encoded_bytes: bytes.length, filename: "data.jsonl",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(create.body.pipeline, "dynaword-upload");
  assert.deepEqual(create.body.parameters, form.parameters);
  assert.deepEqual(create.body.declaration, form.declaration);

  const firstGrant = track.calls.findIndex((c) => c.path.endsWith("/parts"));
  assert.equal(track.calls.slice(0, firstGrant).filter((c) => c.path === `/api/uploads/${JOB}`).length, 3);

  assert.deepEqual(track.puts.map((p) => [p.part, p.method, p.bytes]), [
    [1, "PUT", 8 * MiB], [2, "PUT", 8 * MiB], [3, "PUT", MiB + 5],
  ]);
  const confirm = track.calls.at(-1);
  assert.equal(confirm.path, `/api/uploads/${JOB}/confirm`);
  assert.deepEqual(confirm.body.parts, [
    { part_number: 1, etag: '"etag-1"' }, { part_number: 2, etag: '"etag-2"' }, { part_number: 3, etag: '"etag-3"' },
  ]);
  assert.equal(confirm.body.encoded_bytes, bytes.length);
  assert.equal(confirm.body.input_sha256, create.body.input.sha256);
  assert.match(confirm.body.action_key, /^[!-~]{16,128}$/);
  assert.notEqual(confirm.body.action_key, create.body.action_key);

  assert.ok(file.slices.every(([start, end]) => end - start <= 8 * MiB));
  assert.deepEqual(progress.at(-1), { phase: "confirming", loaded: bytes.length, total: bytes.length });
  assert.ok(progress.some((p) => p.phase === "hashing") && progress.some((p) => p.phase === "uploading"));
});

test("a failed part PUT is retried with a fresh grant", async () => {
  const track = fakeTrack({ readyAfter: 0, failPuts: { 1: 2 } });
  await uploadFile(sliceOnlyFile(randomBytes(1000)), form, deps(track));
  assert.deepEqual(track.puts.map((p) => p.part), [1, 1, 1]);
  assert.equal(new Set(track.puts.map((p) => p.url)).size, 3);
  assert.equal(track.calls.at(-1).body.parts[0].etag, '"etag-1"');
});

test("a part that keeps failing stops the upload, cancels the job and never confirms", async () => {
  const track = fakeTrack({ readyAfter: 0, failPuts: { 1: 99 } });
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(1000)), form, deps(track)), /part 1/i);
  assert.equal(track.puts.length, 4);
  assert.ok(!track.calls.some((c) => c.path.endsWith("/confirm")));
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
});

test("waiting for transfer readiness gives up after a bound", async () => {
  const track = fakeTrack({ readyAfter: Infinity });
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track)), /not ready/i);
  assert.equal(track.puts.length, 0);
});

test("aborting stops the upload before any further part is sent", async () => {
  const controller = new AbortController();
  const track = fakeTrack({ readyAfter: 0 });
  const fetch = async (url, init) => {
    controller.abort();
    return track.fetch(url, init);
  };
  await assert.rejects(
    uploadFile(sliceOnlyFile(randomBytes(9 * MiB)), form, deps(track, { fetch }), { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(track.puts.length, 1);
  assert.ok(!track.calls.some((c) => c.path.endsWith("/confirm")));
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
});

test("an empty file is refused before anything is created", async () => {
  const track = fakeTrack();
  await assert.rejects(uploadFile(sliceOnlyFile(new Uint8Array(0)), form, deps(track)), /empty/i);
  assert.equal(track.calls.length, 0);
});

test("a limit refusal on create is surfaced once and never retried", async () => {
  const track = fakeTrack();
  let creates = 0;
  const call = async (path, init) => {
    creates++;
    throw Object.assign(new Error("You already have an upload in progress. Wait for it to finish or cancel it."), { statusCode: 429 });
  };
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), /already have an upload/);
  assert.equal(creates, 1);
});

test("a transient error while waiting for readiness does not abandon the job", async () => {
  const track = fakeTrack({ readyAfter: 1 });
  let failed = false;
  const call = async (path, init) => {
    if (path === `/api/uploads/${JOB}` && !failed) {
      failed = true;
      throw Object.assign(new Error("Data uploads are temporarily unavailable."), { statusCode: 502 });
    }
    return track.call(path, init);
  };
  assert.equal(await uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), JOB);
  assert.ok(!track.calls.some((c) => c.path.endsWith("/cancel")));
});

test("a storage response without a readable ETag is reported as such", async () => {
  const track = fakeTrack({ readyAfter: 0 });
  const fetch = async (url, init) => {
    await track.fetch(url, init);
    return new Response(null, { status: 200 });
  };
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { fetch })), /ETag/);
});

const failure = (statusCode, code, text = "failed") => Object.assign(new Error(text), { statusCode, code });
const lost = () => new TypeError("Failed to fetch");

function failing(track, path, errors) {
  const queue = [...errors];
  return async (p, init) => {
    if (p === path || p.endsWith(path)) {
      track.calls.push({ path: p, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined, init, failed: true });
      if (queue.length) throw queue.shift();
    }
    return track.call(p, init);
  };
}

const keysOf = (track, suffix) => track.calls.filter((c) => c.path.endsWith(suffix) && c.body).map((c) => c.body.action_key);

test("create is retried with the same key after a lost response or a 5xx", async () => {
  const track = fakeTrack({ readyAfter: 0 });
  const call = failing(track, "/api/uploads", [lost(), failure(502, "provider_unavailable")]);
  assert.equal(await uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), JOB);
  const keys = keysOf(track, "/api/uploads");
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 1);
});

test("aborting while create is in flight still cancels the job it created", async () => {
  const controller = new AbortController();
  const track = fakeTrack({ readyAfter: 0 });
  let createInit;
  const call = async (path, init) => {
    if (path === "/api/uploads") {
      createInit = init;
      controller.abort();
    }
    return track.call(path, init);
  };
  await assert.rejects(
    uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call }), { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(createInit.signal, undefined);
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
  assert.equal(track.puts.length, 0);
});

test("confirm is retried with the same key after a lost response", async () => {
  const track = fakeTrack({ readyAfter: 0 });
  const call = failing(track, "/confirm", [lost(), failure(504, null)]);
  assert.equal(await uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), JOB);
  assert.equal(new Set(keysOf(track, "/confirm")).size, 1);
  assert.ok(!track.calls.some((c) => c.path.endsWith("/cancel")));
});

test("a job whose confirm response was lost is not cancelled once it left the uploading state", async () => {
  const track = fakeTrack({ readyAfter: 0, statusAfterConfirm: { processing_state: "validating", client_phase: "validating" } });
  const call = failing(track, "/confirm", Array.from({ length: 10 }, lost));
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })));
  assert.ok(!track.calls.some((c) => c.path.endsWith("/cancel")));
});

test("a confirm refused with a definite 4xx cancels the job", async () => {
  const track = fakeTrack({ readyAfter: 0 });
  const call = failing(track, "/confirm", [failure(422, "invalid_request", "The data pipeline rejected the request.")]);
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), /rejected the request/);
  assert.equal(track.calls.filter((c) => c.path.endsWith("/confirm")).length, 1);
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
});

test("waiting for readiness fails fast on a non-transient error", async () => {
  const track = fakeTrack({ readyAfter: Infinity });
  const call = failing(track, `/api/uploads/${JOB}`, Array.from({ length: 50 }, () => failure(404, "not_found", "Upload not found.")));
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), /Upload not found/);
  assert.equal(track.calls.filter((c) => c.path === `/api/uploads/${JOB}` && c.failed).length, 1);
});

test("a transfer that closes without becoming ready is an error", async () => {
  const track = fakeTrack({ readyAfter: Infinity });
  const call = async (path, init) => {
    const result = await track.call(path, init);
    return path === `/api/uploads/${JOB}` ? { ...result, transfer_state: "closed" } : result;
  };
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), /closed/);
  assert.equal(track.calls.filter((c) => c.path === `/api/uploads/${JOB}`).length, 1);
});

test("a non-retryable grant error stops the upload with its own message", async () => {
  const track = fakeTrack({ readyAfter: 0 });
  const call = failing(track, "/parts", Array.from({ length: 10 }, () => failure(410, "expired", "This upload has expired.")));
  await assert.rejects(uploadFile(sliceOnlyFile(randomBytes(10)), form, deps(track, { call })), /This upload has expired/);
  assert.equal(track.calls.filter((c) => c.path.endsWith("/parts") && c.failed).length, 1);
  assert.equal(track.puts.length, 0);
});
