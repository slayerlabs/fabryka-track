export type BenchmarkSort = { key: string; direction: "asc" | "desc" };
type SortValue = string | number | null | undefined;
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareBenchmarkValues(a: SortValue, b: SortValue, direction: BenchmarkSort["direction"]) {
  const missingA = a == null || (typeof a === "number" && !Number.isFinite(a));
  const missingB = b == null || (typeof b === "number" && !Number.isFinite(b));
  if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
  const result = typeof a === "number" && typeof b === "number" ? a - b : names.compare(String(a), String(b));
  return direction === "asc" ? result : -result;
}
