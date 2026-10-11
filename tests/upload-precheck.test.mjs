import assert from "node:assert/strict";
import test from "node:test";
import { precheckFile } from "../frontend/src/uploads/precheck.ts";

const CHUNK = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const good = '{"id":1,"text":"valid"}';

function fileFrom(parts, onRead) {
  const chunks = parts.map((part) => typeof part === "string" ? encoder.encode(part) : part);
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const reads = [];
  return {
    name: "sample.jsonl", size, reads,
    slice(start, end) {
      reads.push(end - start);
      return { async arrayBuffer() {
        onRead?.(reads.length);
        const result = new Uint8Array(end - start);
        let position = 0;
        for (const chunk of chunks) {
          const from = Math.max(start, position);
          const to = Math.min(end, position + chunk.length);
          if (to > from) result.set(chunk.subarray(from - position, to - position), from - start);
          position += chunk.length;
          if (position >= end) break;
        }
        return result.buffer;
      } };
    },
  };
}

function longRecord() {
  return ['{"id":1,"text":"', ...Array.from({ length: 32 }, () => new Uint8Array(1024 * 1024).fill(120)), '"}'];
}

function bounded(file) {
  assert.ok(file.reads.every((length) => length <= CHUNK));
  assert.ok(file.reads.length > 1);
}

test("valid records, CRLF, blank lines and EOF count only nonblank rows", async () => {
  for (const data of [`${good}\n${good}\n`, `\r\n  \r\n${good}\r\n\t\r\n${good}`, good]) {
    const report = await precheckFile(fileFrom([data]));
    assert.equal(report.rows, data === good ? 1 : 2);
    assert.equal(report.passed, true);
  }
});

test("null, arrays, missing id, empty text and invalid JSON fail the sample", async () => {
  for (const bad of ['null', '[]', '{"text":"valid"}', '{"id":1,"text":" "}', '{broken']) {
    for (const ending of ['', '\n']) {
      const report = await precheckFile(fileFrom([bad + ending]));
      assert.equal(report.rows, 1);
      assert.equal(report.passed, false, bad);
    }
  }
});

test("record 101 is counted without local validation", async () => {
  const report = await precheckFile(fileFrom([`${(good + '\n').repeat(100)}{broken`]));
  assert.equal(report.rows, 101);
  assert.equal(report.passed, true);
});

test("a long first record is deferred and the following sample is still validated", async () => {
  for (const second of [good, '{broken']) {
    const file = fileFrom([...longRecord(), '\n', second]);
    const report = await precheckFile(file);
    bounded(file);
    assert.equal(report.rows, 2);
    assert.equal(report.passed, second === good);
    const deferred = report.findings.find((finding) => finding.deferred);
    assert.equal(deferred?.count, 1);
    assert.equal(deferred?.ok, true);
    assert.match(deferred?.detail ?? '', /Full validation runs server-side/);
  }
});

test("a long record after the sample is only counted", async () => {
  const file = fileFrom([(good + '\n').repeat(100), ...longRecord()]);
  const report = await precheckFile(file);
  bounded(file);
  assert.equal(report.rows, 101);
  assert.equal(report.passed, true);
  assert.equal(report.findings.some((finding) => finding.deferred), false);
});

test("multibyte UTF-8 across a chunk boundary remains valid within the budget", async () => {
  const recordPrefix = '{"id":1,"text":"';
  const prefix = new Uint8Array(CHUNK - 2 - encoder.encode(recordPrefix).length).fill(32);
  const file = fileFrom([prefix, '\n', recordPrefix, 'żółć"}\n']);
  const report = await precheckFile(file);
  bounded(file);
  assert.equal(report.rows, 1);
  assert.equal(report.passed, true);
  assert.equal(report.findings.some((finding) => finding.deferred), false);
});

test("newline exactly at a chunk boundary completes a bounded sampled row", async () => {
  const padding = new Uint8Array(CHUNK - encoder.encode(good).length - 1).fill(32);
  const file = fileFrom([good, padding, '\n', good]);
  const report = await precheckFile(file);
  bounded(file);
  assert.equal(report.rows, 2);
  assert.equal(report.passed, true);
  assert.equal(report.findings.some((finding) => finding.deferred), false);
});

test("many blank chunks do not consume the sample or create deferred records", async () => {
  const file = fileFrom([new Uint8Array(CHUNK).fill(32), new Uint8Array(CHUNK).fill(32), '\n', good]);
  const report = await precheckFile(file);
  bounded(file);
  assert.equal(report.rows, 1);
  assert.equal(report.passed, true);
  assert.equal(report.findings.some((finding) => finding.deferred), false);
});

test("abort during the final awaited read rejects instead of reporting success", async () => {
  const controller = new AbortController();
  const file = fileFrom([good], () => controller.abort());
  await assert.rejects(precheckFile(file, controller.signal), { name: 'AbortError' });
  assert.equal(file.reads.length, 1);
});

test("abort between chunks prevents the next read", async () => {
  const controller = new AbortController();
  const file = fileFrom(longRecord(), () => setTimeout(() => controller.abort(), 0));
  await assert.rejects(precheckFile(file, controller.signal), { name: 'AbortError' });
  assert.equal(file.reads.length, 1);
});

test("arrayBuffer failure rejects", async () => {
  const error = new Error('read failed');
  const file = { name: 'sample.jsonl', size: 10, slice() { return { arrayBuffer: async () => { throw error; } }; } };
  await assert.rejects(precheckFile(file), error);
});

test("Parquet deeper checks are deferred while its magic check still gates success", async () => {
  for (const data of ['PAR1bodyPAR1', 'wrong']) {
    const file = fileFrom([data]);
    file.name = 'sample.parquet';
    const report = await precheckFile(file);
    assert.equal(report.passed, data.startsWith('PAR1'));
    assert.equal(report.findings.find((finding) => finding.rule === 'depth')?.deferred, true);
  }
});


test("profile size refusal happens before reading; the large profile accepts the same Parquet declaration", async () => {
  let reads = 0;
  const file = { name: "large.parquet", size: 513 * 1024 ** 2,
    slice() { reads++; return new Blob(["PAR1"]); } };
  const refused = await precheckFile(file, undefined, 512 * 1024 ** 2);
  assert.equal(refused.passed, false);
  assert.match(refused.findings[0].detail, /512 MiB/);
  assert.equal(reads, 0);
  assert.equal((await precheckFile(file, undefined, 10 * 1024 ** 3)).passed, true);
  assert.equal(reads, 2);
});

test("a declared 10 GiB JSONL starts bounded real reads and aborts after three chunks", async () => {
  const controller = new AbortController();
  const reads = [];
  const file = { name: "large.jsonl", size: 10 * 1024 ** 3,
    slice(start, end) {
      reads.push([start, end]);
      return { async arrayBuffer() {
        const bytes = new Uint8Array(end - start).fill(32);
        bytes.set(encoder.encode(good + "\n"));
        if (reads.length === 3) controller.abort();
        return bytes.buffer;
      } };
    } };
  await assert.rejects(precheckFile(file, controller.signal), { name: "AbortError" });
  assert.equal(reads.length, 3);
  assert.ok(reads.every(([start, end]) => end - start <= CHUNK));
});
