import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { uploadFile } from "../frontend/src/uploads/uploader.ts";

const MiB = 1024 * 1024;
const BOUND = 4;
const JOB = "6f1c1f3e-2b7a-4d5e-9c3b-1a2b3c4d5e6f";
const TIMEOUT = 2500;

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortError() {
  return Object.assign(new Error("The upload was aborted."), { name: "AbortError" });
}

function ok(part) {
  return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } });
}

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

// PUTs stay in flight until the test releases them; respond() may answer some attempts immediately.
function heldTrack({ respond = () => null } = {}) {
  const attempts = {};
  const calls = [];
  const grants = [];
  const puts = [];
  const pending = new Map();
  const rejected = [];
  const call = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? "GET", body, abortedAtStart: !!init.signal?.aborted });
    if (init.signal?.aborted) throw abortError();
    if (path === "/api/uploads" && init.method === "POST")
      return { job_id: JOB, transfer_state: "pending", part_size_bytes: 8 * MiB };
    if (path === `/api/uploads/${JOB}`) return { job_id: JOB, client_phase: "uploading", processing_state: "uploading", transfer_state: "ready" };
    if (path === `/api/uploads/${JOB}/parts`) {
      grants.push(body.part_number);
      return { method: "PUT", url: `https://bucket.test/part-${body.part_number}?grant=${grants.length}` };
    }
    if (path.endsWith("/confirm") || path.endsWith("/cancel")) return { job_id: JOB };
    throw new Error("unexpected " + path);
  };
  const fetch = async (url, init) => {
    const part = Number(new URL(url).pathname.split("-")[1]);
    const attempt = (attempts[part] ?? 0) + 1;
    attempts[part] = attempt;
    puts.push({ part, attempt, url, abortedAtStart: !!init.signal?.aborted });
    if (init.signal?.aborted) throw abortError();
    const answer = await respond({ part, attempt, url });
    if (answer) return answer;
    if (init.signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          rejected.push(part);
          reject(abortError());
        },
        { once: true },
      );
      pending.set(part, { resolve });
    });
  };
  return { calls, grants, puts, pending, rejected, call, fetch };
}

async function release(track, part) {
  for (let i = 0; i < 100 && !track.pending.has(part); i++) await settle();
  assert.ok(track.pending.has(part), `part ${part} never started, so it cannot be released`);
  track.pending.get(part).resolve(ok(part));
  await settle();
}

function deps(track, extra = {}) {
  let key = 0;
  return {
    call: track.call,
    fetch: track.fetch,
    sleep: async () => {},
    hash: async () => "stub-sha256",
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

test("parts finishing out of order still confirm in part order with the right ETags", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(17 * MiB + 5);
  const track = heldTrack();
  const upload = uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: () => {} });
  await release(track, 3);
  await release(track, 1);
  await release(track, 2);
  const confirm = track.calls.at(-1);
  assert.equal(confirm.path, `/api/uploads/${JOB}/confirm`);
  assert.deepEqual(confirm.body.parts, [
    { part_number: 1, etag: '"etag-1"' },
    { part_number: 2, etag: '"etag-2"' },
    { part_number: 3, etag: '"etag-3"' },
  ]);
  assert.equal(confirm.body.encoded_bytes, bytes.length);
  assert.equal(await upload, JOB);
});

test("uploading progress sums finished bytes and never decreases, out of order", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(17 * MiB + 5);
  const track = heldTrack();
  const progress = [];
  const upload = uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: (p) => progress.push(p) });
  await release(track, 2);
  await release(track, 3);
  await release(track, 1);
  await upload;
  const uploading = progress.filter((p) => p.phase === "uploading");
  assert.deepEqual(uploading.map((p) => p.loaded), [8 * MiB, 9 * MiB + 5, 17 * MiB + 5]);
  assert.ok(uploading.every((p) => p.total === bytes.length));
  assert.deepEqual(progress.at(-1), { phase: "confirming", loaded: bytes.length, total: bytes.length });
});

test("parts are sent in parallel but never exceed the concurrency bound", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(48 * MiB);
  let inflight = 0;
  let peak = 0;
  const track = heldTrack({
    respond: async ({ part }) => {
      peak = Math.max(peak, ++inflight);
      await settle();
      inflight--;
      return ok(part);
    },
  });
  const jobId = await uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: () => {} });
  assert.equal(jobId, JOB);
  assert.equal(peak, BOUND);
  assert.deepEqual(track.grants, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(track.puts.map((p) => p.part), [1, 2, 3, 4, 5, 6]);
  const confirm = track.calls.at(-1);
  assert.equal(confirm.path, `/api/uploads/${JOB}/confirm`);
  assert.deepEqual(confirm.body.parts, Array.from({ length: 6 }, (_, i) => ({ part_number: i + 1, etag: `"etag-${i + 1}"` })));
});

test("a part retries while other parts stay in flight", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(17 * MiB + 5);
  const track = heldTrack({
    respond: ({ part, attempt }) =>
      part === 2 ? (attempt === 1 ? new Response(null, { status: 500 }) : ok(2)) : null,
  });
  const upload = uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: () => {} });
  for (let i = 0; i < 100 && !track.puts.some((p) => p.part === 2 && p.attempt === 2); i++) await settle();
  assert.ok(track.puts.some((p) => p.part === 2 && p.attempt === 2), "part 2 was not retried while parts 1 and 3 were still in flight");
  assert.deepEqual(track.rejected, []);
  const partTwo = track.puts.filter((p) => p.part === 2);
  assert.deepEqual(partTwo.map((p) => p.attempt), [1, 2]);
  assert.equal(new Set(partTwo.map((p) => p.url)).size, 2);
  assert.deepEqual(track.grants, [1, 2, 3, 2]);
  await release(track, 1);
  await release(track, 3);
  assert.equal(await upload, JOB);
  assert.deepEqual(track.calls.at(-1).body.parts, [
    { part_number: 1, etag: '"etag-1"' },
    { part_number: 2, etag: '"etag-2"' },
    { part_number: 3, etag: '"etag-3"' },
  ]);
});

test("stopping the upload aborts the in-flight parts and starts no further requests", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(33 * MiB);
  const controller = new AbortController();
  const track = heldTrack();
  const upload = uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: () => {}, signal: controller.signal });
  for (let i = 0; i < 100 && track.puts.length < 4; i++) await settle();
  assert.equal(track.puts.length, 4);
  assert.equal(track.grants.length, 4);
  controller.abort();
  await assert.rejects(upload, { name: "AbortError" });
  assert.equal(track.puts.length, 4);
  assert.equal(track.grants.length, 4);
  assert.ok(track.puts.every((p) => !p.abortedAtStart));
  assert.ok(track.calls.filter((c) => c.path.endsWith("/parts")).every((c) => !c.abortedAtStart));
  assert.ok(!track.calls.some((c) => c.path.endsWith("/confirm")));
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
  assert.deepEqual([...track.rejected].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("a part that exhausts its retries stops the parts still in flight", { timeout: TIMEOUT }, async () => {
  const bytes = randomBytes(33 * MiB);
  const track = heldTrack({ respond: ({ part, attempt }) => (part === 2 && attempt <= 4 ? new Response(null, { status: 500 }) : null) });
  const upload = uploadFile(sliceOnlyFile(bytes), form, deps(track), { onProgress: () => {} });
  // The upload may reject while we are still waiting for part 2's last attempt; keep that rejection handled.
  upload.catch(() => undefined);
  for (let i = 0; i < 100 && track.puts.filter((p) => p.part === 2).length < 4; i++) await settle();
  assert.equal(track.puts.filter((p) => p.part === 2).length, 4);
  await assert.rejects(upload, /part 2/i);
  assert.deepEqual(track.rejected, [1, 3, 4]);
  assert.deepEqual(track.grants, [1, 2, 3, 4, 2, 2, 2]);
  assert.ok(track.puts.every((p) => !p.abortedAtStart));
  assert.ok(track.calls.filter((c) => c.path.endsWith("/parts")).every((c) => !c.abortedAtStart));
  assert.ok(!track.calls.some((c) => c.path.endsWith("/confirm")));
  assert.equal(track.calls.at(-1).path, `/api/uploads/${JOB}/cancel`);
});