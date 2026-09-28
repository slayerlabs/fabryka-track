import { useState } from "react";
import { useCustom } from "@refinedev/core";
import { Link, useNavigate } from "react-router";
import { compact, format } from "./leaderboard-data";
import {
  NATURAL_DIRECTION,
  RANK_KEY,
  SIZE_BUCKETS,
  TRUST_LABELS,
  filterRows,
  hfLink,
  rankRows,
  sizeBucket,
  sortRows,
  sortValue,
} from "./model-board-data";
import type {
  BoardRow,
  Category,
  Direction,
  SizeKey,
  SortKey,
} from "./model-board-data";
import "../leaderboard.css";

const DOCS_URL =
  "https://github.com/slayerlabs/fabryka-track/blob/main/docs/model-board.md";
const CATEGORY_LABELS: Record<Category, string> = {
  en: "EN",
  pl: "PL",
};
type Column = { key: SortKey; label: string; note?: string; digits?: number };
const SCORE_COLUMNS: Record<Category, Column[]> = {
  en: [
    { key: "en_eff", label: "eff", note: "Glint Tiny-ML", digits: 2 },
    { key: "arc_easy", label: "ARC-Easy", digits: 2 },
    { key: "blimp", label: "BLiMP", digits: 2 },
    {
      key: "wiki_byte_ppl",
      label: "Wiki byte-PPL",
      note: "lower is better",
      digits: 4,
    },
  ],
  pl: [
    {
      key: "multiblimp",
      label: "MultiBLiMP-pl accuracy",
      note: "random = 50 %",
      digits: 2,
    },
  ],
};
const PL_EFF_COLUMN: Column = {
  key: "pl_eff",
  label: "eff-PL",
  note: "not frozen · not ranked",
  digits: 2,
};

function BoardTable({
  rows,
  category,
  columns,
  ranks,
  sort,
  onSort,
  selected,
  toggle,
}: {
  rows: BoardRow[];
  category: Category;
  columns: Column[];
  ranks: Map<string, number>;
  sort: { key: SortKey; direction: Direction };
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  toggle: (id: string) => void;
}) {
  const header = (column: Column) => (
    <th
      scope="col"
      key={column.key}
      aria-sort={
        sort.key === column.key
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button className="mb-sort" onClick={() => onSort(column.key)}>
        {column.label}
        <span aria-hidden="true">
          {sort.key === column.key
            ? sort.direction === "asc"
              ? " ▲"
              : " ▼"
            : ""}
        </span>
        {column.note && <small>{column.note}</small>}
      </button>
    </th>
  );
  return (
    <div
      className="lb-table-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${CATEGORY_LABELS[category]} model results`}
    >
      <table className="lb-table mb-table">
        <thead>
          <tr>
            <th scope="col">Compare</th>
            <th scope="col">Rank</th>
            <th scope="col">Model</th>
            {columns.map(header)}
            {header({ key: "n_params", label: "Params" })}
            {header({ key: "tokens_seen", label: "Tokens" })}
            <th scope="col">Trust</th>
            {header({ key: "date", label: "Date" })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const hf = hfLink(row);
            return (
              <tr
                key={row.run_id}
                className={selected.has(row.run_id) ? "lb-selected" : ""}
              >
                <td>
                  {row.kind === "track" && (
                    <input
                      type="checkbox"
                      aria-label={`Compare ${row.name}`}
                      checked={selected.has(row.run_id)}
                      onChange={() => toggle(row.run_id)}
                    />
                  )}
                </td>
                <td className="lb-number mb-rank">
                  {ranks.get(row.run_id) ?? "—"}
                </td>
                <td className="lb-run-name">
                  {hf ? (
                    <a href={hf} target="_blank" rel="noopener noreferrer">
                      {row.name} ↗
                    </a>
                  ) : (
                    <Link to={`/run/${row.run_id}`}>{row.name}</Link>
                  )}
                  <span>
                    {row.kind === "external"
                      ? `${row.author} · ${row.hf_repo}@${row.revision?.slice(0, 8)} · logged by ${row.owner}`
                      : row.owner}
                  </span>
                  <small>
                    {row.label} · step {row.step.toLocaleString("en-US")} ·
                    ckpt {row.checkpoint_sha256.slice(0, 8)}
                    {row.scale_rev ? " · " : ""}
                    {row.scale_rev && (
                      <abbr title="eff depends on the Glint min/max ranges; compare eff only between rows with the same scale revision.">
                        scale {row.scale_rev}
                      </abbr>
                    )}
                    {row.harness || row.harness_sha
                      ? ` · harness ${[row.harness, row.harness_sha?.slice(0, 8)].filter(Boolean).join(" @ ")}`
                      : ""}
                  </small>
                  {row.public_note && (
                    <small className="mb-note">{row.public_note}</small>
                  )}
                </td>
                {columns.map((column) => (
                  <td className="lb-number" key={column.key}>
                    {column.key === RANK_KEY[category] ? (
                      <strong>
                        {format(sortValue(row, column.key), column.digits)}
                      </strong>
                    ) : (
                      format(sortValue(row, column.key), column.digits)
                    )}
                  </td>
                ))}
                <td className="lb-number">{compact(row.n_params)}</td>
                <td className="lb-number">{compact(row.tokens_seen)}</td>
                <td>
                  <span className={`mb-badge mb-badge-${row.trust}`}>
                    {TRUST_LABELS[row.trust]}
                  </span>
                </td>
                <td className="lb-number">
                  {new Date(
                    row.finished_at ?? row.started_at,
                  ).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ModelBoardPage() {
  const navigate = useNavigate();
  const { query } = useCustom<{ models: BoardRow[] }>({
    url: "/api/leaderboard/models",
    method: "get",
  });
  const [category, setCategory] = useState<Category>("en");
  const [size, setSize] = useState<SizeKey>("all");
  const [hideReported, setHideReported] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction }>({
    key: RANK_KEY.en,
    direction: NATURAL_DIRECTION[RANK_KEY.en],
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const models = query.data?.data.models || [];
  const inCategory = filterRows(models, {
    category,
    size: "all",
    hideReported,
  });
  const visible = filterRows(models, { category, size, hideReported });
  const rows = sortRows(visible, sort.key, sort.direction);
  const ranks = rankRows(visible, category);
  const columns =
    category === "pl" && visible.some((row) => row.pl.eff !== null)
      ? [...SCORE_COLUMNS.pl, PL_EFF_COLUMN]
      : SCORE_COLUMNS[category];
  const chooseCategory = (next: Category) => {
    setCategory(next);
    setSort({
      key: RANK_KEY[next],
      direction: NATURAL_DIRECTION[RANK_KEY[next]],
    });
    setSelected(new Set());
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="leaderboard-page model-board">
      <div className="lb-intro">
        <div>
          <div className="lb-eyebrow">Fabryka research / Model leaderboard</div>
          <h1>One final checkpoint per model.</h1>
          <p>
            Each row is the checkpoint its owner marked as the result, scored
            at exactly that training step.
          </p>
        </div>
        <a
          className="secondary"
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Add a model ↗
        </a>
      </div>
      {query.isError ? (
        <div className="lb-empty" role="alert">
          <h2>Results could not be loaded.</h2>
          <button className="secondary" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <div className="lb-empty" role="status">
          Loading model results…
        </div>
      ) : (
        <>
          <div className="mb-tabs" role="tablist" aria-label="Language">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={category === item}
                onClick={() => chooseCategory(item)}
              >
                {CATEGORY_LABELS[item]}
                <small>
                  {
                    models.filter((row) => row.categories.includes(item))
                      .length
                  }
                </small>
              </button>
            ))}
          </div>
          <p className="lb-group-note">
            {category === "en"
              ? "Ranked by eff, the Glint Tiny-ML efficiency score on a 0–100 scale."
              : "Ranked by MultiBLiMP-pl accuracy (random = 50 %). eff-PL is not frozen yet, so it is shown when available but never ranked."}
          </p>
          <div className="mb-controls">
            <div className="mb-sizes" role="group" aria-label="Model size">
              <button
                aria-pressed={size === "all"}
                onClick={() => setSize("all")}
              >
                All sizes <small>{inCategory.length}</small>
              </button>
              {SIZE_BUCKETS.map((bucket) => (
                <button
                  key={bucket.key}
                  title={bucket.range}
                  aria-pressed={size === bucket.key}
                  onClick={() => setSize(bucket.key)}
                >
                  {bucket.label}{" "}
                  <small>
                    {
                      inCategory.filter(
                        (row) => sizeBucket(row.n_params) === bucket.key,
                      ).length
                    }
                  </small>
                </button>
              ))}
            </div>
            <label className="mb-toggle">
              <input
                type="checkbox"
                checked={hideReported}
                onChange={(event) => setHideReported(event.target.checked)}
              />
              Hide self-reported
            </label>
          </div>
          <div className="lb-results-heading">
            <div>
              <span className="lb-eyebrow">
                {CATEGORY_LABELS[category]} results
              </span>
              <p>
                {rows.length} {rows.length === 1 ? "model" : "models"}
              </p>
            </div>
            <div className="lb-compare">
              <span aria-live="polite">{selected.size} selected</span>
              {selected.size > 0 && (
                <button
                  className="lb-text-button"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              )}
              <button
                className="secondary"
                disabled={selected.size < 2 || selected.size > 10}
                onClick={() =>
                  navigate(
                    `/compare/${[...selected].join(",")}${category === "en" ? "?metric=board%2Feff" : ""}`,
                  )
                }
              >
                Compare runs ↗
              </button>
            </div>
          </div>
          {!rows.length ? (
            <div className="lb-empty">
              <h2>No models in this view yet.</h2>
              <p>
                A finished public run appears here once it publishes its board
                metrics and marks its final checkpoint.
              </p>
            </div>
          ) : (
            <BoardTable
              rows={rows}
              category={category}
              columns={columns}
              ranks={ranks}
              sort={sort}
              onSort={(key) =>
                setSort((current) => ({
                  key,
                  direction:
                    current.key === key
                      ? current.direction === "asc"
                        ? "desc"
                        : "asc"
                      : NATURAL_DIRECTION[key],
                }))
              }
              selected={selected}
              toggle={toggle}
            />
          )}
          <p className="lb-footnote mb-caveat">
            Scores are our measurements with the Glint Tiny-ML protocol, not
            official leaderboard results. eff depends on the Glint min/max
            ranges at the revision shown. Self-reported rows use the authors'
            own protocols.
          </p>
        </>
      )}
    </div>
  );
}
