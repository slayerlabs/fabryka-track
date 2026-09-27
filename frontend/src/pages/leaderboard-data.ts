export interface LeaderModel {
  id: string;
  name: string;
  owner: string;
  rank: number;
  started_at: string;
  steps: number | null;
  val_loss?: number | null;
  perplexity?: number | null;
  train_loss?: number | null;
  throughput?: number | null;
  training_tokens?: number | null;
  estimated_flops?: number | null;
  mix: { name: string; weight: number }[];
  auto_benchmark?: {
    score?: number | null;
    label: string;
    is_percent: boolean;
    state: string;
  } | null;
}
export interface LeaderSize {
  model_size: string;
  parameters?: number;
  models: LeaderModel[];
}
export type GroupBy = "recipe" | "owner" | "none";
export type Axis = "training_tokens" | "estimated_flops" | "steps";
export const colors = [
  "#df4926",
  "#385e96",
  "#8d887f",
  "#357b69",
  "#9b6b9c",
  "#b78630",
  "#447e94",
  "#9d6047",
];
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const format = (value: number | null | undefined, digits = 3) =>
  finite(value)
    ? value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "—";
export const compact = (value: number | null | undefined) =>
  finite(value)
    ? new Intl.NumberFormat("en-US", {
        notation: value >= 1e12 ? "scientific" : "compact",
        maximumFractionDigits: 1,
      }).format(value)
    : "—";

export function recipe(row: LeaderModel): {
  key: string;
  label: string;
  detail: string;
} {
  if (!row.mix.length)
    return {
      key: "unknown",
      label: "Recipe not recorded",
      detail: "No dataset mix available",
    };
  if (row.mix.some((item) => item.name === "Private dataset")) {
    const partial = row.mix.some((item) => item.name !== "Private dataset");
    return {
      key: partial ? "partial" : "private",
      label: partial ? "Partially disclosed recipes" : "Undisclosed recipes",
      detail:
        "Different private datasets may be included; this is not a matched recipe.",
    };
  }
  const weights = new Map<string, number>();
  row.mix.forEach((item) =>
    weights.set(item.name, (weights.get(item.name) || 0) + item.weight),
  );
  const entries = [...weights].sort(([a], [b]) => a.localeCompare(b));
  const byWeight = [...entries].sort((a, b) => b[1] - a[1]);
  return {
    key: JSON.stringify(entries),
    label:
      byWeight
        .slice(0, 2)
        .map(
          ([name, weight]) =>
            `${name} ${format(weight, Number.isInteger(weight) ? 0 : 2)}%`,
        )
        .join(" + ") +
      (entries.length > 2 ? ` + ${entries.length - 2} more` : ""),
    detail: byWeight
      .map(([name, weight]) => `${name} ${format(weight, 0)}%`)
      .join(" · "),
  };
}
export function groupModels(rows: LeaderModel[], by: GroupBy) {
  const groups = new Map<
    string,
    { key: string; label: string; detail: string; rows: LeaderModel[] }
  >();
  for (const row of rows) {
    const info =
      by === "recipe"
        ? recipe(row)
        : by === "owner"
          ? {
              key: row.owner,
              label: row.owner,
              detail: "Published training runs",
            }
          : {
              key: "all",
              label: "All runs",
              detail: "Ordered within this model size",
            };
    if (!groups.has(info.key)) groups.set(info.key, { ...info, rows: [] });
    groups.get(info.key)!.rows.push(row);
  }
  return [...groups.values()];
}
export function sortModels(rows: LeaderModel[], sort: string) {
  return [...rows].sort((a, b) => {
    if (sort === "started_at") return b.started_at.localeCompare(a.started_at);
    const av = a[sort as "val_loss" | "perplexity" | "throughput"],
      bv = b[sort as "val_loss" | "perplexity" | "throughput"];
    if (!finite(av)) return finite(bv) ? 1 : 0;
    if (!finite(bv)) return -1;
    return (av - bv) * (sort === "throughput" ? -1 : 1);
  });
}
