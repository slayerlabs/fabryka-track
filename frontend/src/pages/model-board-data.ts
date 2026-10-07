export type Trust = "verified" | "measured" | "reported" | "track";
export type Category = "en" | "pl" | "plen";
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
  pl: {
    multiblimp: number | null;
    arc_easy: number | null;
    byte_ppl: number | null;
    eff: number | null;
  };
  /** (eff EN + eff-PL) / 2, server-side; null unless both are present. */
  combined: number | null;
}
export type SortKey =
  | "en_eff"
  | "en_overall"
  | "arc_easy"
  | "blimp"
  | "wiki_byte_ppl"
  | "multiblimp"
  | "pl_arc_easy"
  | "pl_byte_ppl"
  | "pl_eff"
  | "combined"
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
// Column direction when first chosen; byte-perplexities are lower-is-better.
export const NATURAL_DIRECTION: Record<SortKey, Direction> = {
  en_eff: "desc",
  en_overall: "desc",
  arc_easy: "desc",
  blimp: "desc",
  wiki_byte_ppl: "asc",
  multiblimp: "desc",
  pl_arc_easy: "desc",
  pl_byte_ppl: "asc",
  pl_eff: "desc",
  combined: "desc",
  n_params: "asc",
  tokens_seen: "asc",
  date: "desc",
};
// The ranked axis per category. PL rows without eff-PL stay unranked below the ranked ones.
export const RANK_KEY: Record<Category, SortKey> = {
  en: "en_eff",
  pl: "pl_eff",
  plen: "combined",
};
/** EN can be ranked by eff (default) or by Overall; other categories ignore the axis. */
export type RankAxis = "eff" | "overall";
export const rankKey = (category: Category, axis: RankAxis = "eff"): SortKey =>
  category === "en" && axis === "overall" ? "en_overall" : RANK_KEY[category];

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const WIKI_PPL_FLOOR = 1.86,
  WIKI_PPL_CEIL = 500;
/** Glint wiki_score (0–100) from Wiki byte-PPL; lower perplexity scores higher. */
export function wikiScore(ppl: number) {
  const ratio =
    Math.log(Math.min(ppl, WIKI_PPL_CEIL) / WIKI_PPL_FLOOR) /
    Math.log(WIKI_PPL_CEIL / WIKI_PPL_FLOOR);
  return 100 * Math.min(1, Math.max(0, 1 - ratio));
}

/** Glint Tiny-ML Overall = (BLiMP + ARC-Easy + wiki_score) / 3, no size bonus; null if any input is missing. */
export function enOverall(row: BoardRow): number | null {
  const { blimp, arc_easy, wiki_byte_ppl } = row.en;
  if (!finite(blimp) || !finite(arc_easy) || !finite(wiki_byte_ppl)) return null;
  return (blimp + arc_easy + wikiScore(wiki_byte_ppl)) / 3;
}

export function sizeBucket(nParams: number): Exclude<SizeKey, "all"> {
  return SIZE_BUCKETS.find((bucket) => nParams <= bucket.max)!.key;
}

export function sortValue(row: BoardRow, key: SortKey): number | null {
  const value = {
    en_eff: row.en.eff,
    en_overall: enOverall(row),
    arc_easy: row.en.arc_easy,
    blimp: row.en.blimp,
    wiki_byte_ppl: row.en.wiki_byte_ppl,
    multiblimp: row.pl.multiblimp,
    pl_arc_easy: row.pl.arc_easy,
    pl_byte_ppl: row.pl.byte_ppl,
    pl_eff: row.pl.eff,
    combined: row.combined,
    n_params: row.n_params,
    tokens_seen: row.tokens_seen,
    date: Date.parse(row.finished_at ?? row.started_at),
  }[key];
  return finite(value) ? value : null;
}

/** Stable sort; rows without a value stay last in both directions. Rows without eff-PL
 * follow by MultiBLiMP-pl (desc) when sorting by eff-PL. */
export function sortRows(rows: BoardRow[], key: SortKey, direction: Direction) {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key),
      bv = sortValue(b, key);
    if (av === null && bv === null && key === "pl_eff") {
      const am = sortValue(a, "multiblimp"),
        bm = sortValue(b, "multiblimp");
      if (am === null) return bm === null ? 0 : 1;
      return bm === null ? -1 : bm - am;
    }
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
export function rankRows(
  rows: BoardRow[],
  category: Category,
  axis: RankAxis = "eff",
) {
  const key = rankKey(category, axis);
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

/** External model measured by us ("measured by Fabryka"); its PL values carry the dagger. Self-reported never do. */
export const measuredByUs = (row: BoardRow) =>
  row.kind === "external" && row.trust === "measured";

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
