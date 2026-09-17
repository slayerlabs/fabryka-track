import type { Dataset } from "./StudioDatasetReader";

export interface RecipeSource {
  name: string;
  repo: string;
  config: string;
  split: string;
  text_column: string;
  weight: number;
}
export const ivmeSources: readonly RecipeSource[] = [
  { name: "FineWeb-Edu", repo: "HuggingFaceFW/fineweb-edu", config: "sample-10BT", split: "train", text_column: "text", weight: 46.67 },
  { name: "DCLM", repo: "mlfoundations/dclm-baseline-1.0", config: "default", split: "train", text_column: "text", weight: 27.78 },
  { name: "FineWiki English", repo: "HuggingFaceFW/finewiki", config: "en", split: "train", text_column: "text", weight: 8.89 },
  { name: "FineMath 3+", repo: "HuggingFaceTB/finemath", config: "finemath-3plus", split: "train", text_column: "text", weight: 7.78 },
  { name: "Cosmopedia v2", repo: "HuggingFaceTB/smollm-corpus", config: "cosmopedia-v2", split: "train", text_column: "text", weight: 5.56 },
  { name: "SimpleStories", repo: "SimpleStories/SimpleStories", config: "default", split: "train", text_column: "story", weight: 3.32 },
];

export const roundShare = (value: number) => Math.round(value * 100) / 100;
export const totalShares = (values: number[]) =>
  values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
export const validShare = (value: number) =>
  Number.isFinite(value) && value >= 0.01 && value <= 100 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;

export function findRecipeDataset(source: RecipeSource, datasets: Dataset[]) {
  let best: Dataset | undefined;
  for (const dataset of datasets) {
    const { source: stored, bytes } = dataset;
    if (bytes >= 4096 && stored?.kind === "huggingface" &&
      stored.repo === source.repo && stored.config === source.config &&
      stored.split === source.split && stored.text_column === source.text_column &&
      !stored.contains && !stored.excludes &&
      (!Array.isArray(stored.rules) || stored.rules.length === 0) &&
      (!best || bytes > best.bytes)) best = dataset;
  }
  return best;
}

export function ivmeWeights(datasets: Dataset[]): Record<string, number> | null {
  const pairs = ivmeSources.map((source) => {
    const dataset = findRecipeDataset(source, datasets);
    return dataset ? [dataset.id, source.weight] as const : null;
  });
  if (pairs.some((pair) => pair === null)) return null;
  return Object.fromEntries(pairs.filter((pair) => pair !== null));
}

// Largest-remainder apportionment preserves ratios and totals exactly 100%.
export function normalizeShares(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights).filter(([, value]) => Number.isFinite(value) && value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return {};
  const parts = entries.map(([id, value]) => {
    const exact = value / total * 10000;
    return { id, cents: Math.floor(exact), remainder: exact % 1 };
  });
  let left = 10000 - parts.reduce((sum, item) => sum + item.cents, 0);
  for (const item of [...parts].sort((a, b) => b.remainder - a.remainder)) {
    if (left-- > 0) item.cents++;
  }
  return Object.fromEntries(parts.map((item) => [item.id, item.cents / 100]));
}
