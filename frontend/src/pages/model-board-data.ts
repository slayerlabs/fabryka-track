export type Trust = "verified" | "measured" | "reported" | "track";
export type Category = "en" | "pl";
export interface BoardRow {
  run_id: string;
  name: string;
  owner: string;
  kind: "track" | "external";
  trust: Trust;
  author: string | null;
  hf_repo: string | null;
  revision: string | null;
  hf_url: string | null;
  n_params: number;
  tokens_seen: number | null;
  checkpoint_sha256: string | null;
  harness: string | null;
  harness_sha: string | null;
  scale_rev: string | null;
  step: number | null;
  label: string;
  evaluated_at: string | null;
  started_at: string;
  finished_at: string | null;
  public_note: string | null;
  categories: Category[];
  en: {
    eff: number | null;
    arc_easy: number | null;
    blimp: number | null;
    wiki_byte_ppl: number | null;
  };
  pl: { multiblimp: number | null; eff: number | null };
}
export type SortKey =
  | "en_eff"
  | "arc_easy"
  | "blimp"
  | "wiki_byte_ppl"
  | "multiblimp"
  | "pl_eff"
  | "n_params"
  | "tokens_seen"
  | "date";
export type Direction = "asc" | "desc";
export type SizeKey = "all" | "16" | "32" | "64" | "150" | "350" | "350+";

export const TRUST_LABELS: Record<Trust, string> = {
  verified: "verified ✓",
  measured: "measured by Fabryka",
  reported: "self-reported (different protocol)",
  track: "measured by track",
};
// Disjoint size classes on n_params, upper bounds inclusive, decimal millions.
export const SIZE_BUCKETS: {
  key: Exclude<SizeKey, "all">;
  label: string;
  range: string;
  max: number;
}[] = [
  { key: "16", label: "≤16M", range: "up to 16M parameters", max: 16e6 },
  { key: "32", label: "≤32M", range: "16M–32M parameters", max: 32e6 },
  { key: "64", label: "≤64M", range: "32M–64M parameters", max: 64e6 },
  { key: "150", label: "≤150M", range: "64M–150M parameters", max: 150e6 },
  { key: "350", label: "≤350M", range: "150M–350M parameters", max: 350e6 },
  { key: "350+", label: ">350M", range: "over 350M parameters", max: Infinity },
];
// Column direction when first chosen; wiki byte-perplexity is lower-is-better.
export const NATURAL_DIRECTION: Record<SortKey, Direction> = {
  en_eff: "desc",
  arc_easy: "desc",
  blimp: "desc",
  wiki_byte_ppl: "asc",
  multiblimp: "desc",
  pl_eff: "desc",
  n_params: "asc",
  tokens_seen: "asc",
  date: "desc",
};
// The ranked axis per category. eff-PL is not frozen, so PL ranks by MultiBLiMP-pl.
export const RANK_KEY: Record<Category, SortKey> = {
  en: "en_eff",
  pl: "multiblimp",
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function sizeBucket(nParams: number): Exclude<SizeKey, "all"> {
  return SIZE_BUCKETS.find((bucket) => nParams <= bucket.max)!.key;
}

export function sortValue(row: BoardRow, key: SortKey): number | null {
  const value = {
    en_eff: row.en.eff,
    arc_easy: row.en.arc_easy,
    blimp: row.en.blimp,
    wiki_byte_ppl: row.en.wiki_byte_ppl,
    multiblimp: row.pl.multiblimp,
    pl_eff: row.pl.eff,
    n_params: row.n_params,
    tokens_seen: row.tokens_seen,
    date: Date.parse(row.finished_at ?? row.started_at),
  }[key];
  return finite(value) ? value : null;
}

/** Stable sort; rows without a value stay last in both directions. */
export function sortRows(rows: BoardRow[], key: SortKey, direction: Direction) {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key),
      bv = sortValue(b, key);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return (av - bv) * sign;
  });
}

export function filterRows(
  rows: BoardRow[],
  {
    category,
    size,
    hideReported,
  }: { category: Category; size: SizeKey; hideReported: boolean },
) {
  return rows.filter(
    (row) =>
      row.categories.includes(category) &&
      (size === "all" || sizeBucket(row.n_params) === size) &&
      !(hideReported && row.trust === "reported"),
  );
}

/** Competition ranks (1, 2, 2, 4) by the category's ranked axis; independent of display sort. */
export function rankRows(rows: BoardRow[], category: Category) {
  const key = RANK_KEY[category];
  const ranks = new Map<string, number>();
  let previous: number | null = null,
    rank = 0;
  sortRows(rows, key, NATURAL_DIRECTION[key]).forEach((row, index) => {
    const value = sortValue(row, key);
    if (value === null) return;
    if (value !== previous) rank = index + 1;
    previous = value;
    ranks.set(row.run_id, rank);
  });
  return ranks;
}

/** External rows link only to the server-built Hugging Face tree URL. */
export function hfLink(row: BoardRow) {
  return row.kind === "external" &&
    row.hf_url?.startsWith("https://huggingface.co/")
    ? row.hf_url
    : null;
}

/** Provenance line under the model name; parts a server-measured row may lack are omitted. */
export function checkpointDetails(row: BoardRow) {
  return [
    row.label,
    row.evaluated_at &&
      new Date(row.evaluated_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    row.step !== null && `step ${row.step.toLocaleString("en-US")}`,
    row.checkpoint_sha256 && `ckpt ${row.checkpoint_sha256.slice(0, 8)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
