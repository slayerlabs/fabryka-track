import type { UploadJob, UploadReport } from "./api.ts";
import { CHECK_LABELS, REJECT_LABELS, STAGE_LABELS } from "./copy.ts";
import { describeJob } from "./display.ts";

export type ReportPayload = UploadReport;

export interface ResultsDeps {
  getUpload(id: string, signal?: AbortSignal): Promise<UploadJob>;
  getReport(id: string, signal?: AbortSignal): Promise<UploadReport>;
}

export interface UploadResults {
  job: UploadJob;
  report: UploadReport | null;
  reportError: string;
}

export async function loadUploadResults(id: string, deps: ResultsDeps, signal?: AbortSignal): Promise<UploadResults> {
  const job = await deps.getUpload(id, signal);
  signal?.throwIfAborted();
  if (!describeJob(job).hasReport || job.client_phase === "expired") return { job, report: null, reportError: "" };
  try {
    return { job, report: await deps.getReport(id, signal), reportError: "" };
  } catch (error) {
    signal?.throwIfAborted();
    return { job, report: null, reportError: error instanceof Error ? error.message : "Something went wrong. Try again." };
  }
}

export interface Cards {
  verdict: string | null;
  failureCode: string | null;
  rowsIn: number | null;
  rowsOut: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  tokens: number | null;
}

export interface FunnelStage {
  key: string;
  label: string;
  removed: number;
  remaining: number;
  reasons: { reason: string; label: string; count: number }[];
}

export interface Funnel {
  rowsIn: number;
  rowsOut: number | null;
  stages: FunnelStage[];
}

export interface CheckRow {
  name: string;
  label: string;
  binding: boolean;
  status: string;
  count: number | null;
}

export interface Pii {
  phone: number;
  pii: number;
  person: number;
  records: number;
}

export interface Summary {
  cards: Cards;
  funnel: Funnel | null;
  checks: CheckRow[] | null;
  pii: Pii | null;
}

const STAGE_ORDER = Object.keys(STAGE_LABELS);
const REASON_ORDER = Object.keys(REJECT_LABELS);
const CHECK_ORDER = Object.keys(CHECK_LABELS);

const count = (value: unknown) => (typeof value === "number" ? value : null);

function rank(order: string[], name: string) {
  const index = order.indexOf(name);
  return index < 0 ? order.length : index;
}

function funnelOf(source: NonNullable<NonNullable<UploadReport["report"]>["report"]>["funnel"]): Funnel | null {
  const rowsIn = count(source?.rows_in);
  if (rowsIn === null) return null;
  const reasons = Object.entries(source?.rejected ?? {})
    .flatMap(([reason, n]) => (typeof n === "number" ? [{ reason, label: REJECT_LABELS[reason] ?? reason, count: n }] : []))
    .sort((a, b) => rank(REASON_ORDER, a.reason) - rank(REASON_ORDER, b.reason));
  const removed = source?.removed ?? {};
  const names = [...STAGE_ORDER, ...Object.keys(removed).filter((name) => !STAGE_ORDER.includes(name))];
  const rejectedTotal = reasons.reduce((sum, reason) => sum + reason.count, 0);
  let remaining = rowsIn - rejectedTotal;
  const stages: FunnelStage[] = [{ key: "intake", label: "Intake", removed: rejectedTotal, remaining, reasons }];
  for (const name of names) {
    const n = count(removed[name]) ?? 0;
    remaining -= n;
    stages.push({ key: name, label: STAGE_LABELS[name] ?? name, removed: n, remaining, reasons: [] });
  }
  return { rowsIn, rowsOut: count(source?.rows_out), stages };
}

export function summarize(payload: ReportPayload | null): Summary {
  const body = payload?.report;
  const qa = body?.qa;
  const rows = qa?.checks ?? null;
  const binding = rows?.filter((check) => check.binding) ?? null;
  const masked = body?.report?.pii_masked;
  const cards: Cards = {
    verdict: payload?.verdict ?? null,
    failureCode: payload?.failure_code ?? null,
    rowsIn: count(body?.rows_in) ?? count(body?.report?.funnel?.rows_in),
    rowsOut: count(body?.rows_out) ?? count(body?.report?.funnel?.rows_out),
    checksPassed: binding ? binding.filter((check) => check.status === "passed").length : null,
    checksTotal: binding ? binding.length : null,
    tokens: count(qa?.stats?.token_count),
  };
  return {
    cards,
    funnel: body?.report?.funnel ? funnelOf(body.report.funnel) : null,
    checks: rows && [...rows]
      .sort((a, b) => rank(CHECK_ORDER, a.name ?? "") - rank(CHECK_ORDER, b.name ?? ""))
      .map((check) => ({ name: check.name ?? "", label: CHECK_LABELS[check.name ?? ""] ?? check.name ?? "", binding: check.binding === true, status: check.status ?? "", count: count(check.count) })),
    pii: masked ? { phone: count(masked.phone) ?? 0, pii: count(masked.pii) ?? 0, person: count(masked.person) ?? 0, records: count(masked.records) ?? 0 } : null,
  };
}
