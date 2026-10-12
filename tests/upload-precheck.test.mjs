import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXACT_COUNT_LIMIT, SAMPLE_BYTES, SAMPLE_RECORDS, precheckFile } from "../frontend/src/uploads/precheck.ts";

const MIB = 1024 * 1024;
const LIMIT = 10 * 1024 ** 3;
const encoder = new TextEncoder();
const parquet = JSON.parse(readFileSync(new URL("./fixtures/upload-parquet.json", import.meta.url), "utf8"));
const good = (n) => `{"id":${n},"text":"valid ${n}"}`;

function tracked(bytes, name) {
  const blob = new Blob([bytes]);
  const reads = [];
  return {
    name, size: blob.size, reads,
    slice(start, end) { reads.push([start, end]); return blob.slice(start, end); },
    arrayBuffer() { throw new Error("whole-file read"); },
  };
}

const jsonl = (text, name = "data.jsonl") => tracked(encoder.encode(text), name);
const lines = (count, make = good) => Array.from({ length: count }, (_, i) => make(i + 1)).join("\n") + "\n";
const parquetFile = (key, name = "data.parquet") => tracked(Buffer.from(parquet[key].base64, "base64"), name);

function virtual(size, line, name = "big.jsonl") {
  const pattern = encoder.encode(line + "\n");
  const reads = [];
  return {
    name, size, reads, pattern,
    slice(start, end) {
      reads.push([start, end]);
      return { async arrayBuffer() {
        const out = new Uint8Array(end - start);
        const shift = start % pattern.length;
        const at = Math.min(out.length, pattern.length - shift);
        out.set(pattern.subarray(shift, shift + at));
        if (at < out.length) {
          const unit = Math.min(pattern.length, out.length - at);
          out.set(pattern.subarray(0, unit), at);
          for (let filled = unit; at + filled < out.length; filled *= 2)
            out.copyWithin(at + filled, at, at + Math.min(filled, out.length - at - filled));
        }
        return out.buffer;
      } };
    },
  };
}

test("the sample constants match the example profile preflight", () => {
  assert.equal(SAMPLE_RECORDS, 100);
  assert.equal(SAMPLE_BYTES, 1048576);
  assert.equal(EXACT_COUNT_LIMIT, 536870912);
});

test("an unknown extension blocks without reading the file", async () => {
  const file = jsonl(lines(2), "notes.txt");
  const report = await precheckFile(file, LIMIT);
  assert.equal(report.format, null);
  assert.equal(report.rows, null);
  assert.deepEqual(report.blocking.map((finding) => finding.code), ["extension"]);
  assert.deepEqual(file.reads, []);
});

test("an empty file blocks", async () => {
  const report = await precheckFile(jsonl(""), LIMIT);
  assert.deepEqual(report.blocking.map((finding) => finding.code), ["empty"]);
});

test("a file above the limit blocks and a file at the limit does not", async () => {
  const text = lines(3);
  const size = encoder.encode(text).length;
  const over = await precheckFile(jsonl(text), size - 1);
  assert.deepEqual(over.blocking.map((finding) => finding.code), ["size"]);
  assert.match(over.blocking[0].message, /larger than/);
  assert.equal(over.size, size);
  const at = await precheckFile(jsonl(text), size);
  assert.deepEqual(at.blocking, []);
});

test("a valid JSONL file passes with an exact row count", async () => {
  const report = await precheckFile(jsonl(lines(3)), LIMIT);
  assert.equal(report.format, "jsonl");
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.rows, { count: 3, exact: true });
});

test("blank lines, CRLF and a missing final newline do not change the count", async () => {
  const text = `${good(1)}\r\n\r\n  \t\r\n${good(2)}\r\n\n${good(3)}`;
  const report = await precheckFile(jsonl(text), LIMIT);
  assert.deepEqual(report.rows, { count: 3, exact: true });
  assert.deepEqual(report.warnings, []);
});

test("id is a non-blank string or an integer and text a non-blank string", async () => {
  const cases = [
    ['{"id":"a","text":"x"}', null],
    ['{"id":7,"text":"x"}', null],
    ['{"id":true,"text":"x"}', "invalid_id"],
    ['{"id":1.5,"text":"x"}', "invalid_id"],
    ['{"id":[1],"text":"x"}', "invalid_id"],
    ['{"id":null,"text":"x"}', "missing_id"],
    ['{"text":"x"}', "missing_id"],
    ['{"id":"  ","text":"x"}', "missing_id"],
    ['{"id":1}', "invalid_text"],
    ['{"id":1,"text":5}', "invalid_text"],
    ['{"id":1,"text":"  "}', "empty_text"],
    ["[1]", "not_an_object"],
    ["null", "not_an_object"],
    ['"text"', "not_an_object"],
    ["{broken", "unparseable"],
  ];
  for (const [bad, reason] of cases) {
    const report = await precheckFile(jsonl(`${good(99)}\n${bad}\n`), LIMIT);
    assert.deepEqual(report.blocking, [], bad);
    if (!reason) {
      assert.deepEqual(report.warnings, [], bad);
      continue;
    }
    assert.equal(report.warnings.length, 1, bad);
    assert.deepEqual(report.warnings[0].example, { position: 2, reason }, bad);
    assert.equal(report.warnings[0].count, 1);
  }
});

test("a repeated id is a warning on the later record, whatever its type", async () => {
  const report = await precheckFile(jsonl(`{"id":1,"text":"a"}\n{"id":"1","text":"b"}\n`), LIMIT);
  assert.deepEqual(report.warnings[0].example, { position: 2, reason: "duplicate_id" });
  assert.deepEqual(report.blocking, []);
});

test("a few invalid records warn with their count and the first example, positions counting blank lines", async () => {
  const text = [good(1), "", "{broken", good(2), '{"id":3}', good(4)].join("\n");
  const report = await precheckFile(jsonl(text), LIMIT);
  assert.deepEqual(report.blocking, []);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].count, 2);
  assert.deepEqual(report.warnings[0].example, { position: 3, reason: "unparseable" });
  assert.match(report.warnings[0].message, /2 of the first 5/);
  assert.match(report.warnings[0].message, /Record 3 is not valid JSON/);
});

test("when every sampled record is invalid the upload is blocked", async () => {
  const report = await precheckFile(jsonl(lines(5, () => '{"id":1}')), LIMIT);
  assert.deepEqual(report.blocking.map((finding) => finding.code), ["all_invalid"]);
  assert.equal(report.blocking[0].count, 5);
  assert.deepEqual(report.blocking[0].example, { position: 1, reason: "invalid_text" });
  assert.deepEqual(report.warnings, []);
});

test("only the first 100 records are judged", async () => {
  const lateBad = lines(150, (n) => (n > 100 ? "{broken" : good(n)));
  const a = await precheckFile(jsonl(lateBad), LIMIT);
  assert.deepEqual([a.blocking, a.warnings], [[], []]);
  assert.deepEqual(a.rows, { count: 150, exact: true });

  const lateGood = lines(150, (n) => (n <= 100 ? "{broken" : good(n)));
  const b = await precheckFile(jsonl(lateGood), LIMIT);
  assert.deepEqual(b.blocking.map((finding) => finding.code), ["all_invalid"]);
  assert.equal(b.blocking[0].count, 100);
});

test("a file without any record warns and does not block", async () => {
  const report = await precheckFile(jsonl("\n  \n\n"), LIMIT);
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.warnings.map((finding) => finding.code), ["no_records"]);
  assert.deepEqual(report.rows, { count: 0, exact: true });
});

test("the sample stops at 1 MiB and a record cut by it is never judged", async () => {
  const big = (n) => `{"id":${n},"text":"${"x".repeat(20000)}"}`;
  const file = jsonl(lines(80, big));
  const report = await precheckFile(file, LIMIT);
  assert.deepEqual([report.blocking, report.warnings], [[], []]);
  assert.ok(file.reads.some(([start, end]) => start === 0 && end === SAMPLE_BYTES));
  assert.deepEqual(report.rows, { count: 80, exact: true });
});

test("a short sample that is all invalid does not block when the sample was cut", async () => {
  const bad = (n) => `{"id":${n},"text":${"1".repeat(30000)}}`;
  const report = await precheckFile(jsonl(lines(60, bad)), LIMIT);
  assert.deepEqual(report.blocking, []);
  assert.equal(report.warnings[0].example.reason, "invalid_text");
});

test("one record larger than the sample says nothing about the file", async () => {
  const huge = `{"id":1,"text":"${"x".repeat(SAMPLE_BYTES + 10)}"}\n`;
  const report = await precheckFile(jsonl(huge + good(2) + "\n"), LIMIT);
  assert.deepEqual([report.blocking, report.warnings], [[], []]);
  assert.deepEqual(report.rows, { count: 2, exact: true });
});

test("an invalid UTF-8 line is unparseable", async () => {
  const bytes = new Uint8Array([...encoder.encode(good(1) + "\n"), 0x7b, 0xff, 0x7d, 0x0a]);
  const report = await precheckFile(tracked(bytes, "x.jsonl"), LIMIT);
  assert.deepEqual(report.warnings[0].example, { position: 2, reason: "unparseable" });
});

test("exact counting reaches 512 MiB and nothing past the sample is read above it", async () => {
  const line = `{"id":1,"text":"${"y".repeat(45)}"}`;
  const lineBytes = encoder.encode(line + "\n").length;
  assert.equal(EXACT_COUNT_LIMIT % lineBytes, 0);
  const exact = virtual(EXACT_COUNT_LIMIT, line);
  const a = await precheckFile(exact, LIMIT);
  assert.deepEqual(a.rows, { count: EXACT_COUNT_LIMIT / lineBytes, exact: true });
  assert.ok(exact.reads.some(([, end]) => end === EXACT_COUNT_LIMIT));

  const above = virtual(EXACT_COUNT_LIMIT + lineBytes, line);
  const b = await precheckFile(above, LIMIT);
  assert.equal(b.rows.exact, false);
  assert.equal(b.rows.count, (EXACT_COUNT_LIMIT + lineBytes) / lineBytes);
  assert.ok(above.reads.every(([start, end]) => start === 0 && end <= SAMPLE_BYTES));
});

test("the estimate divides the size by the mean sampled record size", async () => {
  const line = '{"id":1,"text":"a"}';
  const lineBytes = encoder.encode(line + "\n").length;
  const size = EXACT_COUNT_LIMIT * 4 + 12345;
  const report = await precheckFile(virtual(size, line), LIMIT);
  assert.equal(report.rows.exact, false);
  assert.equal(report.rows.count, Math.round(size / lineBytes));
});

test("an aborted check rejects", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(precheckFile(jsonl(lines(3)), LIMIT, controller.signal));
});

test("Parquet takes its row count and columns from the footer", async () => {
  for (const key of ["good", "wide", "empty"]) {
    const file = parquetFile(key);
    const report = await precheckFile(file, LIMIT);
    assert.equal(report.format, "parquet");
    assert.deepEqual(report.blocking, [], key);
    assert.deepEqual(report.rows, { count: parquet[key].rows, exact: true }, key);
    assert.ok(file.reads.every(([start, end]) => end - start <= file.size), key);
  }
  assert.deepEqual((await precheckFile(parquetFile("empty"), LIMIT)).warnings.map((finding) => finding.code), ["no_records"]);
});

test("a Parquet file without an id or text column is blocked by column", async () => {
  const messages = async (key) => (await precheckFile(parquetFile(key), LIMIT)).blocking.map((finding) => [finding.code, finding.message]);
  assert.deepEqual(await messages("no_text"), [["parquet_column", "The Parquet file has no text column."]]);
  assert.deepEqual(await messages("no_id"), [["parquet_column", "The Parquet file has no id column."]]);
  assert.deepEqual(await messages("neither"), [
    ["parquet_column", "The Parquet file has no id column."],
    ["parquet_column", "The Parquet file has no text column."],
  ]);
  assert.equal((await messages("nested_only")).length, 2);
});

test("extension and content must agree", async () => {
  const asJsonl = await precheckFile(parquetFile("good", "data.jsonl"), LIMIT);
  assert.deepEqual(asJsonl.blocking.map((finding) => finding.code), ["format_mismatch"]);
  const asParquet = await precheckFile(jsonl(lines(3), "data.parquet"), LIMIT);
  assert.deepEqual(asParquet.blocking.map((finding) => finding.code), ["format_mismatch"]);
  assert.equal(asParquet.format, "parquet");
  const truncated = await precheckFile(tracked(Buffer.from(parquet.good.base64, "base64").subarray(0, 300), "t.parquet"), LIMIT);
  assert.deepEqual(truncated.blocking.map((finding) => finding.code), ["format_mismatch"]);
});

test("a Parquet footer that cannot be read never blocks", async () => {
  const bytes = Buffer.from(parquet.good.base64, "base64");
  const junk = Buffer.from(bytes);
  junk.fill(0xff, junk.length - 8 - 60, junk.length - 8);
  const badLength = Buffer.from(bytes);
  badLength.writeUInt32LE(0x7fffffff, badLength.length - 8);
  const tiny = Buffer.concat([Buffer.from("PAR1"), Buffer.alloc(4), Buffer.from("PAR1")]);
  for (const data of [junk, badLength, tiny]) {
    const report = await precheckFile(tracked(data, "x.parquet"), LIMIT);
    assert.deepEqual(report.blocking, []);
    assert.equal(report.rows, null);
  }
});

test("NaN and Infinity are accepted by the server preflight, so they warn and never block", async () => {
  for (const token of ["NaN", "Infinity", "-Infinity"]) {
    const report = await precheckFile(jsonl(lines(5, (n) => `{"id":${n},"text":"t","score":${token}}`)), LIMIT);
    assert.deepEqual(report.blocking, [], token);
    assert.equal(report.warnings.length, 1, token);
    assert.equal(report.warnings[0].count, 5);
    assert.deepEqual(report.warnings[0].example, { position: 1, reason: "unparseable" });
    assert.match(report.warnings[0].message, /NaN or Infinity/);
  }
});

test("a NaN inside a string is just text and genuinely broken JSON still blocks", async () => {
  const text = await precheckFile(jsonl(lines(3, (n) => `{"id":${n},"text":"NaN Infinity"}`)), LIMIT);
  assert.deepEqual([text.blocking, text.warnings], [[], []]);
  const broken = await precheckFile(jsonl(lines(3, () => '{"id":1,"text":NaN')), LIMIT);
  assert.deepEqual(broken.blocking.map((finding) => finding.code), ["all_invalid"]);
});
