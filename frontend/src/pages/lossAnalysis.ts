import type { Point } from "./RunData";

// Only attach token counts logged at the exact same step. Never extrapolate
// a batch size from the run's planned token budget.
export function tokenLookup(metrics: Record<string, Point[]>) {
  const lookup = new Map<number, number>();
  for (const key of ["checkpoint/tokens", "training/tokens_seen"])
    for (const p of metrics[key] || [])
      if (Number.isFinite(p.value) && p.value >= 0) lookup.set(p.step, p.value);
  return lookup;
}
export function withTokens(
  points: Point[],
  lookup: Map<number, number>,
): Point[] {
  return points.map((p) => ({ ...p, tokens: p.tokens ?? lookup.get(p.step) }));
}
export function distinctValidation(points: Point[]): Point[] {
  // Repeated evaluations of the same token position must not double its weight.
  const latest = new Map<string, Point>();
  for (const p of points)
    if (Number.isFinite(p.value))
      latest.set(`${p.step}:${p.tokens ?? "unknown"}`, p);
  return [...latest.values()].sort((a, b) => a.step - b.step);
}
export function rollingReduction(
  points: Point[],
  window: number,
  resumeStep?: number,
): Point[] {
  const phases =
    resumeStep === undefined
      ? [points]
      : [
          points.filter((p) => p.step <= resumeStep),
          points.filter((p) => p.step > resumeStep),
        ];
  const result: Point[] = [];
  for (const phase of phases) {
    let segment: Point[] = [];
    for (const p of distinctValidation(phase)) {
      if (!Number.isFinite(p.tokens)) {
        segment = [];
        continue;
      }
      if (segment.length && p.tokens! <= segment.at(-1)!.tokens!) segment = [];
      segment.push(p);
      if (segment.length < window) continue;
      const sample = segment.slice(-window);
      const origin = sample[0].tokens!;
      const xs = sample.map((s) => (s.tokens! - origin) / 1e9);
      const meanX = xs.reduce((a, b) => a + b, 0) / window;
      const meanY = sample.reduce((a, b) => a + b.value, 0) / window;
      const variance = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
      if (variance <= 0) continue;
      const slope =
        xs.reduce(
          (sum, x, i) => sum + (x - meanX) * (sample[i].value - meanY),
          0,
        ) / variance;
      result.push({ ...p, value: -slope });
    }
  }
  return result;
}
