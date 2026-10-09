import type { UploadReport } from "./api.ts";

export interface SummaryRow {
  label: string;
  value: string;
}

export interface SummarySection {
  title: string;
  rows: SummaryRow[];
}

const REJECT_REASON_LABELS: Record<string, string> = {
  unparseable: "unparseable line",
  not_an_object: "not a JSON object",
  missing_id: "missing id",
  invalid_id: "invalid id",
  duplicate_id: "duplicate id",
  invalid_text: "invalid text",
  empty_text: "empty text",
  source_mismatch: "source mismatch",
  invalid_field_type: "invalid field type",
  invalid_date: "invalid date",
  missing_license: "missing license",
  missing_source_ref: "missing source_ref",
};

const STAGE_LABELS: Record<string, string> = {
  quality_labels: "Too short",
  upload_dedup: "Near or exact duplicates",
  masked_exact_dedup: "Duplicates after masking",
};

const PII_LABELS: Record<string, string> = {
  phone: "Phone numbers",
  pii: "Other personal data (PESEL, email…)",
  person: "Person names",
};

const STAT_LABELS: Record<string, string> = {
  token_count: "Tokens",
  exact_duplicate_pairs: "Exact duplicate pairs",
  near_duplicate_pairs: "Near-duplicate pairs",
  residual_pii_records: "Records with remaining personal data",
  license_review_records: "Records needing license review",
};

const label = (map: Record<string, string>, name: string) => map[name] ?? name;

const count = (value: number) => value.toLocaleString("en-US");

function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${count(value)} B`;
}

function duration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

const isNumber = (value: unknown): value is number => typeof value === "number";

function present(rows: [string, string | undefined][]): SummaryRow[] {
  return rows.flatMap(([name, value]) => (value === undefined ? [] : [{ label: name, value }]));
}

const format = (value: unknown, render: (n: number) => string = count) => (isNumber(value) ? render(value) : undefined);

export function summarizeReport(report: UploadReport): SummarySection[] {
  const body = report.report;
  if (!body) return [];
  const funnel = body.report?.funnel;
  const masked = body.report?.pii_masked;
  const stats = body.qa?.stats;
  const unmeasured = body.report?.pii_unmeasured;
  const counters = body.counters;

  const records = present(funnel
    ? [
        ["Records in", format(funnel.rows_in)],
        ...Object.entries(funnel.rejected ?? {}).map(([k, v]): [string, string | undefined] => [`Rejected: ${label(REJECT_REASON_LABELS, k)}`, format(v)]),
        ...Object.entries(funnel.removed ?? {}).map(([k, v]): [string, string | undefined] => [`Removed: ${label(STAGE_LABELS, k).toLowerCase()}`, format(v)]),
        ["Records out", format(funnel.rows_out)],
      ]
    : [["Records in", format(body.rows_in)], ["Records out", format(body.rows_out)]]);

  const happened = present([
    ...Object.entries(STAT_LABELS).map(([k, name]): [string, string | undefined] => [name, format(stats?.[k])]),
    ["Not measured", unmeasured?.length ? unmeasured.join(", ") : undefined],
  ]);

  const masks = masked
    ? present([
        ...Object.entries(PII_LABELS).map(([k, name]): [string, string | undefined] => [name, format(masked[k])]),
        ["Records with a mask", format(masked.records)],
      ])
    : [];

  const processing = present([
    ["Processing time", format(counters?.elapsed_ms, duration)],
    ["Input size", format(counters?.input_bytes, bytes)],
    ["Output size", format(counters?.output_bytes, bytes)],
  ]);

  return [
    { title: "Records", rows: records },
    { title: "What happened to the data", rows: happened },
    { title: "Personal data masked", rows: masks },
    { title: "Processing", rows: processing },
  ].filter((section) => section.rows.length > 0);
}

export const checksOpen = (report: UploadReport) =>
  (report.report?.qa?.checks ?? []).some((check) => check.status === "failed");
