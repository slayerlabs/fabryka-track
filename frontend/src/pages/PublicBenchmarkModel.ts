export interface Measurement {
  task: string;
  benchmark: string;
  metric: string;
  metric_label: string;
  value: number | null;
  unit: string;
  higher_is_better: boolean;
  samples: number | null;
  sample_unit: string;
  sample_digest: string | null;
  dataset_revisions: Record<string, string | number | boolean>;
  task_versions: Record<string, string | number | boolean>;
  splits: Record<string, string | number | boolean>;
}
export interface PublishedReport {
  id: string;
  run_id: string;
  run_name: string;
  owner: string;
  model_size: string | null;
  mode: string;
  created_at: string;
  ended_at?: string | null;
  run_url: string;
  source_url: string;
  checkpoint: {
    checkpoint_sha256?: string;
    parameters?: number;
    checkpoint_step?: number;
    training_tokens?: number;
    context_length?: number;
    token_unit?: string;
  };
  evidence: {
    protocol?: string;
    harness_version?: string;
    scoring_implementation?: string;
    scoring?: string;
    fewshot?: number;
    seed?: number;
  };
  measurements: Measurement[];
}
export interface ComparisonRow {
  report: PublishedReport;
  measurement: Measurement;
}
export const TASK_LANG: Record<string, string> = {
  multiblimp_polish: "pl",
  pl_lm: "pl",
  pl_multiblimp: "pl",
  pl_induction: "pl",
  sciq: "en",
  arc_easy: "en",
  arc_challenge: "en",
  piqa: "en",
  hellaswag: "en",
  blimp: "en",
  lambada_openai: "en",
  winogrande: "en",
  boolq: "en",
  fast_lm: "en",
  fast_blimp: "en",
  fast_supplement: "en",
  fast_arc: "en",
  fast_ewok: "en",
  bananamind_base_1_1: "en",
  arithmark2: "neutral",
  arithmark3: "neutral",
  int_index: "neutral",
};
export const LANG_META: Record<string, [string, string, string]> = {
  pl: ["PL", "Polish", "#1d4ed8"],
  en: ["EN", "English", "#6b7280"],
  neutral: ["NEU", "Language-neutral (math / index)", "#0f766e"],
};
export function format(measurement: Partial<Measurement>) {
  const value = measurement.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return measurement.unit === "percent"
    ? (value * 100).toFixed(2) + "%"
    : measurement.unit === "elo"
      ? Math.round(value) + " Elo"
      : measurement.unit === "index"
        ? value.toFixed(2)
        : value.toFixed(3);
}
export function plMargin(measurement?: Partial<Measurement>) {
  return typeof measurement?.value === "number" &&
    Number.isFinite(measurement.value)
    ? (measurement.value - 0.5) * 2
    : null;
}
export function plDiverges(
  marginMeasurement?: Partial<Measurement>,
  crosscheckMeasurement?: Partial<Measurement>,
) {
  const margin = plMargin(marginMeasurement),
    crosscheck = plMargin(crosscheckMeasurement);
  return (
    margin !== null &&
    crosscheck !== null &&
    ((margin > 0 && crosscheck < 0) || (margin < 0 && crosscheck > 0))
  );
}
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function cohortKey(report: PublishedReport, measurement: Measurement) {
  const p = report.evidence;
  if (
    !/^[a-f0-9]{64}$/.test(measurement.sample_digest || "") ||
    typeof measurement.samples !== "number" ||
    !Number.isFinite(measurement.samples) ||
    measurement.samples <= 0 ||
    !p.protocol ||
    !p.harness_version ||
    !p.scoring_implementation ||
    !Number.isFinite(p.fewshot) ||
    !Number.isFinite(p.seed) ||
    !Object.keys(measurement.dataset_revisions || {}).length
  )
    return null;
  return canonical({
    mode: report.mode,
    task: measurement.task,
    metric: measurement.metric,
    protocol: p.protocol,
    harness: p.harness_version,
    scoring: p.scoring_implementation,
    fewshot: p.fewshot,
    seed: p.seed,
    samples: measurement.samples,
    sample_unit: measurement.sample_unit || "examples",
    digest: measurement.sample_digest,
    revisions: measurement.dataset_revisions,
    versions: measurement.task_versions,
    splits: measurement.splits,
  });
}
export function comparisonGroups(
  reports: PublishedReport[],
  task: string,
  metric: string,
): [string, ComparisonRow[]][] {
  const groups = new Map<string, ComparisonRow[]>();
  const latest = [...reports].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  for (const report of latest)
    for (const measurement of report.measurements) {
      if (
        measurement.task !== task ||
        measurement.metric !== metric ||
        typeof measurement.value !== "number" ||
        !Number.isFinite(measurement.value)
      )
        continue;
      const key = cohortKey(report, measurement);
      if (!key) continue;
      let rows = groups.get(key);
      if (!rows) {
        rows = [];
        groups.set(key, rows);
      }
      const checkpoint = report.checkpoint.checkpoint_sha256 || report.run_id;
      if (
        !rows.some(
          (row) =>
            (row.report.checkpoint.checkpoint_sha256 || row.report.run_id) ===
            checkpoint,
        )
      )
        rows.push({ report, measurement });
    }
  for (const rows of groups.values())
    rows.sort(
      (a, b) =>
        (a.measurement.higher_is_better ? -1 : 1) *
          (a.measurement.value! - b.measurement.value!) ||
        a.report.run_name.localeCompare(b.report.run_name),
    );
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}
