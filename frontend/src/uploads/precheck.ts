import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, formatFor } from "./form.ts";
import type { SliceableFile } from "./uploader.ts";

export interface PrecheckFinding {
  rule: string;
  ok: boolean;
  detail?: string;
  count?: number;
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
  const decoder = new TextDecoder();
  let rows = 0;
  let checked = 0;
  let badParse = 0;
  let badRecords = 0;
  let firstBadLine = 0;
  let rest = "";
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    rest += decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      rows += 1;
      if (checked >= HEAD_ROWS) continue;
      checked += 1;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        badParse += 1;
        if (!firstBadLine) firstBadLine = rows;
        continue;
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        badRecords += 1;
        if (!firstBadLine) firstBadLine = rows;
        continue;
      }
      const fields = record as Record<string, unknown>;
      if (!validId(fields.id) || !validText(fields.text)) {
        badRecords += 1;
        if (!firstBadLine) firstBadLine = rows;
      }
    }
  }
  rest += decoder.decode();
  if (rest.trim()) {
    rows += 1;
    if (checked < HEAD_ROWS) {
      checked += 1;
      try {
        const record = JSON.parse(rest) as Record<string, unknown>;
        if (typeof record !== "object" || record === null || !validId(record.id) || !validText(record.text)) {
          badRecords += 1;
          if (!firstBadLine) firstBadLine = rows;
        }
      } catch {
        badParse += 1;
        if (!firstBadLine) firstBadLine = rows;
      }
    }
  }
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
  return { format: "jsonl", size: file.size, rows, findings, passed: findings.every((finding) => finding.ok) };
}

async function checkParquet(file: SliceableFile, signal?: AbortSignal): Promise<PrecheckReport> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  signal?.throwIfAborted();
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4), file.size).arrayBuffer());
  const text = new TextDecoder();
  const magic = text.decode(head) === PARQUET_MAGIC && text.decode(tail) === PARQUET_MAGIC;
  return {
    format: "parquet",
    size: file.size,
    findings: [
      magic
        ? { rule: "magic", ok: true, detail: "Parquet header and footer present." }
        : { rule: "magic", ok: false, detail: "Not a Parquet file: PAR1 markers missing." },
      { rule: "depth", ok: true, detail: "Deeper Parquet checks run server-side after upload." },
    ],
    passed: magic,
  };
}

export async function precheckFile(file: SliceableFile, signal?: AbortSignal): Promise<PrecheckReport> {
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
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      format,
      size: file.size,
      findings: [{ rule: "size", ok: false, detail: `The file is larger than ${MAX_UPLOAD_LABEL}.` }],
      passed: false,
    };
  }
  return format === "jsonl" ? checkJsonl(file, signal) : checkParquet(file, signal);
}
