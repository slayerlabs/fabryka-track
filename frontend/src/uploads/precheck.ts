import { formatBytes } from "./bytes.ts";
import { formatFor } from "./form.ts";
import { readParquetFooter } from "./parquet.ts";
import { rejectionMessage } from "./rejection.ts";

export const SAMPLE_RECORDS = 100;
export const SAMPLE_BYTES = 1048576;
export const EXACT_COUNT_LIMIT = 536870912;

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FOOTER_BYTES = 64 * 1024 * 1024;
const MAGIC = [0x50, 0x41, 0x52, 0x31];
const NEWLINE = 10;

export type CheckedFile = Blob & { name: string };

export interface Finding {
  code: string;
  message: string;
  count?: number;
  example?: { position: number; reason: string };
}

export interface PrecheckReport {
  format: "jsonl" | "parquet" | null;
  size: number;
  blocking: Finding[];
  warnings: Finding[];
  rows: { count: number; exact: boolean } | null;
}

const isBlankByte = (byte: number) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

function hasContent(bytes: Uint8Array, start: number, end: number) {
  for (let i = start; i < end; i++) if (!isBlankByte(bytes[i])) return true;
  return false;
}

const hasMagic = (bytes: Uint8Array, at: number) => MAGIC.every((byte, i) => bytes[at + i] === byte);

async function read(file: CheckedFile, start: number, end: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  signal?.throwIfAborted();
  return bytes;
}

type Verdict = { reason: string; field: string | null } | null;

const FIELD_OF: Record<string, string> = { missing_id: "id", invalid_id: "id", duplicate_id: "id", invalid_text: "text", empty_text: "text" };
const reject = (reason: string): Verdict => ({ reason, field: FIELD_OF[reason] ?? null });

function judge(line: Uint8Array, seen: Set<string>): Verdict {
  let record: unknown;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line));
  } catch {
    return reject("unparseable");
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return reject("not_an_object");
  const { id, text } = record as Record<string, unknown>;
  if (id === null || id === undefined) return reject("missing_id");
  if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) return reject("invalid_id");
  const key = String(id).trim();
  if (!key) return reject("missing_id");
  if (seen.has(key)) return reject("duplicate_id");
  if (typeof text !== "string") return reject("invalid_text");
  if (!text.trim()) return reject("empty_text");
  seen.add(key);
  return null;
}

interface Sample {
  judged: number;
  invalid: number;
  first: { position: number; reason: string; field: string | null } | null;
  meanBytes: number;
}

function judgeSample(sample: Uint8Array, complete: boolean): Sample {
  const seen = new Set<string>();
  const result: Sample = { judged: 0, invalid: 0, first: null, meanBytes: 0 };
  let start = 0;
  let consumed = 0;
  for (let position = 1; result.judged < SAMPLE_RECORDS; position++) {
    const newline = sample.indexOf(NEWLINE, start);
    if (newline < 0 && !(complete && start < sample.length)) break;
    const end = newline < 0 ? sample.length : newline;
    if (hasContent(sample, start, end)) {
      result.judged++;
      consumed = Math.min(end + 1, sample.length);
      const verdict = judge(sample.subarray(start, end), seen);
      if (verdict) {
        result.invalid++;
        result.first ??= { position, ...verdict };
      }
    }
    start = end + 1;
  }
  if (result.judged) result.meanBytes = consumed / result.judged;
  return result;
}

async function countRows(file: CheckedFile, signal?: AbortSignal) {
  let rows = 0;
  let content = false;
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const bytes = await read(file, offset, Math.min(file.size, offset + CHUNK_BYTES), signal);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(NEWLINE, start);
      const end = newline < 0 ? bytes.length : newline;
      content ||= hasContent(bytes, start, end);
      if (newline < 0) break;
      if (content) rows++;
      content = false;
      start = newline + 1;
    }
  }
  return content ? rows + 1 : rows;
}

const describe = (sample: Sample) =>
  rejectionMessage({ position: sample.first!.position, rule: sample.first!.reason, field: sample.first!.field });

async function checkJsonl(file: CheckedFile, report: PrecheckReport, signal?: AbortSignal) {
  const complete = file.size <= SAMPLE_BYTES;
  const bytes = await read(file, 0, Math.min(file.size, SAMPLE_BYTES), signal);
  if (hasMagic(bytes, 0)) {
    report.blocking.push({ code: "format_mismatch", message: "This is a Parquet file but its name ends in .jsonl. Rename it to .parquet or upload JSONL." });
    return;
  }
  const sample = judgeSample(bytes, complete);
  if (sample.judged && sample.invalid === sample.judged && (complete || sample.judged === SAMPLE_RECORDS)) {
    report.blocking.push({
      code: "all_invalid",
      message: `All ${sample.judged} checked records are invalid, so this file would be refused. First problem: ${describe(sample)}`,
      count: sample.invalid,
      example: { position: sample.first!.position, reason: sample.first!.reason },
    });
  } else if (sample.invalid) {
    report.warnings.push({
      code: "invalid_records",
      message: `${sample.invalid} of the first ${sample.judged} records are invalid and would be rejected. First problem: ${describe(sample)}`,
      count: sample.invalid,
      example: { position: sample.first!.position, reason: sample.first!.reason },
    });
  }
  if (file.size <= EXACT_COUNT_LIMIT) report.rows = { count: await countRows(file, signal), exact: true };
  else if (sample.judged) report.rows = { count: Math.round(file.size / sample.meanBytes), exact: false };
  if (report.rows?.count === 0 && complete) report.warnings.push({ code: "no_records", message: "The file has no records." });
}

async function checkParquet(file: CheckedFile, report: PrecheckReport, signal?: AbortSignal) {
  const mismatch = () => report.blocking.push({ code: "format_mismatch", message: "This is not a Parquet file: its PAR1 markers are missing." });
  if (file.size < 12) return mismatch();
  const head = await read(file, 0, 4, signal);
  const tail = await read(file, file.size - 8, file.size, signal);
  if (!hasMagic(head, 0) || !hasMagic(tail, 4)) return mismatch();
  const length = new DataView(tail.buffer).getUint32(0, true);
  if (length + 12 > file.size || length > MAX_FOOTER_BYTES) return;
  let footer;
  try {
    footer = readParquetFooter(await read(file, file.size - 8 - length, file.size - 8, signal));
  } catch {
    signal?.throwIfAborted();
    return;
  }
  for (const field of ["id", "text"])
    if (!footer.columns.includes(field))
      report.blocking.push({ code: "parquet_column", message: rejectionMessage({ position: 0, rule: "parquet_column", field }) });
  report.rows = { count: footer.rows, exact: true };
  if (!footer.rows) report.warnings.push({ code: "no_records", message: "The file has no records." });
}

export async function precheckFile(file: CheckedFile, limitBytes: number, signal?: AbortSignal): Promise<PrecheckReport> {
  const format = formatFor(file.name);
  const report: PrecheckReport = { format, size: file.size, blocking: [], warnings: [], rows: null };
  if (!format) {
    report.blocking.push({ code: "extension", message: "Choose a .jsonl or .parquet file." });
  } else if (file.size === 0) {
    report.blocking.push({ code: "empty", message: "The file is empty." });
  } else if (file.size > limitBytes) {
    report.blocking.push({ code: "size", message: `The file is ${formatBytes(file.size)}, which is larger than the ${formatBytes(limitBytes)} this mode accepts.` });
  } else if (format === "jsonl") {
    await checkJsonl(file, report, signal);
  } else {
    await checkParquet(file, report, signal);
  }
  return report;
}
