import { MAX_UPLOAD_BYTES, uploadLimitLabel, formatFor } from "./form.ts";
import type { SliceableFile } from "./uploader.ts";

export interface PrecheckFinding {
  rule: string;
  ok: boolean;
  detail?: string;
  count?: number;
  deferred?: boolean;
}

export interface PrecheckReport {
  format: "jsonl" | "parquet" | null;
  size: number;
  rows?: number;
  findings: PrecheckFinding[];
  passed: boolean;
}

const HEAD_ROWS = 100;
const CHUNK_BYTES = 8 * 1024 * 1024;
const PARQUET_MAGIC = "PAR1";

function validId(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" && Number.isInteger(value);
}

function validText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

async function checkJsonl(file: SliceableFile, signal?: AbortSignal): Promise<PrecheckReport> {
  const findings: PrecheckFinding[] = [];
  let decoder = new TextDecoder();
  let rows = 0;
  let checked = 0;
  let badParse = 0;
  let badRecords = 0;
  let firstBadLine = 0;
  let deferredCount = 0;
  let nonBlank = false;
  let encodedLength = 0;
  let fragments: string[] = [];
  let oversize = false;

  function append(segment: Uint8Array) {
    encodedLength += segment.byteLength;
    if (encodedLength > CHUNK_BYTES) {
      oversize = true;
      fragments = [];
    }
    if (nonBlank && (oversize || rows >= HEAD_ROWS)) return;
    const text = decoder.decode(segment, { stream: true });
    if (!nonBlank && text.trim()) nonBlank = true;
    if (!oversize && rows < HEAD_ROWS) fragments.push(text);
  }

  function finishRow() {
    const tail = decoder.decode();
    if (tail.trim()) nonBlank = true;
    if (nonBlank) {
      rows += 1;
      if (checked < HEAD_ROWS) {
        checked += 1;
        if (oversize) {
          deferredCount += 1;
        } else {
          let record: unknown;
          try {
            record = JSON.parse(fragments.join("") + tail);
          } catch {
            badParse += 1;
            if (!firstBadLine) firstBadLine = rows;
          }
          if (record !== undefined) {
            if (typeof record !== "object" || record === null || Array.isArray(record) ||
                !validId((record as Record<string, unknown>).id) || !validText((record as Record<string, unknown>).text)) {
              badRecords += 1;
              if (!firstBadLine) firstBadLine = rows;
            }
          }
        }
      }
    }
    decoder = new TextDecoder();
    nonBlank = false;
    encodedLength = 0;
    fragments = [];
    oversize = false;
  }

  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    signal?.throwIfAborted();
    let start = 0;
    let newline = bytes.indexOf(10, start);
    while (newline !== -1) {
      append(bytes.subarray(start, newline));
      finishRow();
      start = newline + 1;
      newline = bytes.indexOf(10, start);
    }
    append(bytes.subarray(start));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
  }
  finishRow();
  if (rows === 0) {
    findings.push({ rule: "rows", ok: false, detail: "No data rows found." });
  } else {
    findings.push({ rule: "rows", ok: true, count: rows, detail: `${rows.toLocaleString("en-US")} rows counted.` });
  }
  if (badParse > 0) {
    findings.push({
      rule: "json",
      ok: false,
      count: badParse,
      detail: `${badParse} ${badParse === 1 ? "line is" : "lines are"} not valid JSON (first at line ${firstBadLine}).`,
    });
  }
  if (badRecords > 0) {
    findings.push({
      rule: "records",
      ok: false,
      count: badRecords,
      detail: `${badRecords} of the first ${checked} rows miss an id or non-blank text (first at line ${firstBadLine}).`,
    });
  }
  if (deferredCount > 0) {
    findings.push({
      rule: "sample", ok: true, deferred: true, count: deferredCount,
      detail: "Some sampled records exceeded the local sample budget. Full validation runs server-side.",
    });
  }
  return { format: "jsonl", size: file.size, rows, findings, passed: findings.every((finding) => finding.ok) };
}

async function checkParquet(file: SliceableFile, signal?: AbortSignal): Promise<PrecheckReport> {
  signal?.throwIfAborted();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  signal?.throwIfAborted();
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4), file.size).arrayBuffer());
  signal?.throwIfAborted();
  const text = new TextDecoder();
  const magic = text.decode(head) === PARQUET_MAGIC && text.decode(tail) === PARQUET_MAGIC;
  return {
    format: "parquet",
    size: file.size,
    findings: [
      magic
        ? { rule: "magic", ok: true, detail: "Parquet header and footer present." }
        : { rule: "magic", ok: false, detail: "Not a Parquet file: PAR1 markers missing." },
      { rule: "depth", ok: true, deferred: true, detail: "Deeper Parquet checks run server-side after upload." },
    ],
    passed: magic,
  };
}

export async function precheckFile(file: SliceableFile, signal?: AbortSignal, maxBytes = MAX_UPLOAD_BYTES): Promise<PrecheckReport> {
  const format = formatFor(file.name);
  if (!format) {
    return {
      format: null,
      size: file.size,
      findings: [{ rule: "extension", ok: false, detail: "Choose a .jsonl or .parquet file." }],
      passed: false,
    };
  }
  if (file.size === 0) {
    return {
      format,
      size: 0,
      findings: [{ rule: "empty", ok: false, detail: "The file is empty." }],
      passed: false,
    };
  }
  if (file.size > Math.min(maxBytes, MAX_UPLOAD_BYTES)) {
    return {
      format,
      size: file.size,
      findings: [{ rule: "size", ok: false, detail: `The file is larger than ${uploadLimitLabel(Math.min(maxBytes, MAX_UPLOAD_BYTES))}.` }],
      passed: false,
    };
  }
  return format === "jsonl" ? checkJsonl(file, signal) : checkParquet(file, signal);
}
