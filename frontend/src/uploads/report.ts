import type { UploadReport } from "./api.ts";
import { formatBytes } from "./bytes.ts";
import { PII_LABELS, REJECT_LABELS, STAGE_LABELS } from "./copy.ts";

export interface SummaryRow {
  label: string;
  value: string;
}

export interface SummarySection {
  title: string;
  rows: SummaryRow[];
}

const STAT_LABELS: Record<string, string> = {
  token_count: "Tokens",
  exact_duplicate_pairs: "Exact duplicate pairs",
  near_duplicate_pairs: "Near-duplicate pairs",
  residual_pii_records: "Records with remaining personal data",
  license_review_records: "Records needing license review",
};

function inOrder(counts: Record<string, number> | undefined, known: Record<string, string>) {
  const entries = Object.entries(counts ?? {});
  const rank = (name: string) => Object.keys(known).indexOf(name);
  return [...entries.filter(([k]) => rank(k) >= 0).sort(([a], [b]) => rank(a) - rank(b)), ...entries.filter(([k]) => rank(k) < 0)];
}

const label = (map: Record<string, string>, name: string) => map[name] ?? name;

const count = (value: number) => value.toLocaleString("en-US");

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
        ...inOrder(funnel.rejected, REJECT_LABELS).map(([k, v]): [string, string | undefined] => [`Rejected: ${label(REJECT_LABELS, k)}`, format(v)]),
        ...inOrder(funnel.removed, STAGE_LABELS).map(([k, v]): [string, string | undefined] => [`Removed: ${label(STAGE_LABELS, k).toLowerCase()}`, format(v)]),
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
    ["Input size", format(counters?.input_bytes, formatBytes)],
    ["Output size", format(counters?.output_bytes, formatBytes)],
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
