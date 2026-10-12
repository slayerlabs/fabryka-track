import assert from "node:assert/strict";
import test from "node:test";
import { COPY } from "../frontend/src/uploads/copy.ts";
import { hashInWorker } from "../frontend/src/uploads/workerHash.ts";

class FakeWorker {
  posted = [];
  terminated = 0;
  onmessage = null;
  onerror = null;
  postMessage(data) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated++;
  }
  reply(data) {
    this.onmessage?.({ data });
  }
}

const file = { size: 3, slice: () => new Blob(["abc"]) };

function start(signal) {
  const worker = new FakeWorker();
  const progress = [];
  const result = hashInWorker(() => worker, file, (loaded) => progress.push(loaded), signal);
  return { worker, progress, result };
}

test("progress is forwarded and the digest resolves after the worker is closed", async () => {
  const { worker, progress, result } = start();
  assert.deepEqual(worker.posted, [file]);
  worker.reply({ loaded: 1 });
  worker.reply({ loaded: 3 });
  worker.reply({ digest: "abc123" });
  assert.equal(await result, "abc123");
  assert.deepEqual(progress, [1, 3]);
  assert.equal(worker.terminated, 1);
});

test("a failed read in the worker rejects with a readable message", async () => {
  const { worker, result } = start();
  worker.reply({ failed: true });
  await assert.rejects(result, { message: COPY.progress.fileUnreadable });
  assert.equal(worker.terminated, 1);
});

test("a worker error rejects with the same message", async () => {
  const { worker, result } = start();
  worker.onerror();
  await assert.rejects(result, { message: COPY.progress.fileUnreadable });
  assert.equal(worker.terminated, 1);
});

test("a worker that cannot be created rejects with the same message", async () => {
  const result = hashInWorker(() => {
    throw new ReferenceError("Worker is not defined");
  }, file, () => {});
  await assert.rejects(result, { message: COPY.progress.fileUnreadable });
});

test("an abort before start creates no worker", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  let created = 0;
  await assert.rejects(hashInWorker(() => (created++, new FakeWorker()), file, () => {}, controller.signal), /stopped/);
  assert.equal(created, 0);
});

test("an abort while hashing closes the worker and ignores later messages", async () => {
  const controller = new AbortController();
  const { worker, progress, result } = start(controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(result, /stopped/);
  assert.equal(worker.terminated, 1);
  worker.reply({ loaded: 2 });
  assert.deepEqual(progress, []);
});
