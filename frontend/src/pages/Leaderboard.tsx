import { useState } from "react";
import { useCustom } from "@refinedev/core";
import { Link, useNavigate } from "react-router";
import {
  colors,
  compact,
  finite,
  format,
  groupModels,
  sortModels,
} from "./leaderboard-data";
import type {
  Axis,
  GroupBy,
  LeaderModel,
  LeaderSize,
} from "./leaderboard-data";
import "../leaderboard.css";

const axisLabels: Record<Axis, string> = {
  training_tokens: "Training tokens",
  estimated_flops: "Estimated training FLOPs",
  steps: "Training steps",
};
function ResultsChart({
  rows,
  groupBy,
  axis,
}: {
  rows: LeaderModel[];
  groupBy: GroupBy;
  axis: Axis;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const groups = groupModels(rows, groupBy);
  const points = rows.filter(
    (row) => finite(row.val_loss) && finite(row[axis]) && row[axis]! > 0,
  );
  const focused = points.find((row) => row.id === hovered);
  if (!points.length)
    return (
      <div className="lb-chart-empty">
        No recorded {axisLabels[axis].toLowerCase()} for these runs. Try the
        training steps axis.
      </div>
    );
  const xs = points.map((row) => Math.log10(row[axis]!)),
    ys = points.map((row) => row.val_loss!);
  const minX = Math.floor(Math.min(...xs)),
    maxX = Math.max(minX + 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor((Math.min(...ys) - 0.1) * 2) / 2),
    maxY = Math.max(minY + 0.5, Math.ceil((Math.max(...ys) + 0.1) * 2) / 2);
  const x = (v: number) => 78 + ((Math.log10(v) - minX) / (maxX - minX)) * 842;
  const y = (v: number) => 316 - ((v - minY) / (maxY - minY)) * 270;
  const ticks = Array.from(
    { length: 5 },
    (_, i) => minY + ((maxY - minY) * i) / 4,
  );
  return (
    <>
      <div className="lb-chart-scroll">
        <svg
          className="lb-chart"
          viewBox="0 0 960 390"
          role="group"
          aria-label={`Saved-checkpoint validation loss versus ${axisLabels[axis].toLowerCase()}. Each point links to its run.`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1="78"
                x2="920"
                y1={y(tick)}
                y2={y(tick)}
                className="lb-grid"
              />
              <text x="63" y={y(tick) + 4} textAnchor="end">
                {tick.toFixed(2)}
              </text>
            </g>
          ))}
          {Array.from({ length: maxX - minX + 1 }, (_, i) => minX + i).map(
            (tick) => (
              <g key={tick}>
                <line
                  x1={x(10 ** tick)}
                  x2={x(10 ** tick)}
                  y1="46"
                  y2="316"
                  className="lb-grid lb-grid-vertical"
                />
                <text x={x(10 ** tick)} y="341" textAnchor="middle">
                  10
                  <tspan baselineShift="super" fontSize="9">
                    {tick}
                  </tspan>
                </text>
              </g>
            ),
          )}
          <path d="M78 46 V316 H920" fill="none" stroke="#44413c" />
          <text x="499" y="377" textAnchor="middle">
            {axisLabels[axis]} (log scale)
          </text>
          <text transform="translate(20 181) rotate(-90)" textAnchor="middle">
            Validation loss ↓
          </text>
          {groups.map((group, index) =>
            group.rows
              .filter((row) => points.includes(row))
              .map((row) => (
                <a
                  key={row.id}
                  href={`/run/${row.id}`}
                  aria-label={`${row.name}: loss ${format(row.val_loss)}, ${axisLabels[axis]} ${compact(row[axis])}`}
                  onMouseEnter={() => setHovered(row.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(row.id)}
                  onBlur={() => setHovered(null)}
                >
                  <circle
                    cx={x(row[axis]!)}
                    cy={y(row.val_loss!)}
                    r={hovered === row.id ? 8 : 5.5}
                    fill={colors[index % colors.length]}
                    stroke="#faf9f6"
                    strokeWidth="2"
                    opacity={hovered && hovered !== row.id ? 0.35 : 0.9}
                  />
                  <title>
                    {row.name} · {group.label} · loss {format(row.val_loss)} ·{" "}
                    {axisLabels[axis]} {format(row[axis], 0)}
                  </title>
                </a>
              )),
          )}
        </svg>
      </div>
      <div className="lb-chart-readout" aria-live="polite">
        {focused ? (
          <>
            <strong>{focused.name}</strong>
            <span>
              Loss {format(focused.val_loss)} · {compact(focused[axis])}{" "}
              {axisLabels[axis].toLowerCase()}
            </span>
          </>
        ) : (
          <>
            <span>
              Each dot is a published run. Hover or focus for details; select to
              open.
            </span>
            <span>
              {points.length} / {rows.length} runs plotted
            </span>
          </>
        )}
      </div>
      <details className="lb-legend-details" open={groups.length <= 6}>
        <summary>{groups.length} chart groups · view legend</summary>
        <div className="lb-legend">
          {groups.map((group, index) => (
            <a href={`#lb-group-${index}`} key={group.key} title={group.detail}>
              <i style={{ background: colors[index % colors.length] }} />
              <span>{group.label}</span>
              <small>{group.rows.length}</small>
            </a>
          ))}
        </div>
      </details>
    </>
  );
}

function RunTable({
  rows,
  selected,
  toggle,
}: {
  rows: LeaderModel[];
  selected: Set<string>;
  toggle: (id: string) => void;
}) {
  return (
    <div
      className="lb-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Training run results"
    >
      <table className="lb-table">
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Run</th>
            <th scope="col">Loss ↓</th>
            <th scope="col">Perplexity ↓</th>
            <th scope="col">Tokens / s ↑</th>
            <th scope="col">Benchmark</th>
            <th scope="col">Data mix</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={selected.has(row.id) ? "lb-selected" : ""}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`Compare ${row.name}`}
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
              </td>
              <td className="lb-run-name">
                <Link to={`/run/${row.id}`}>{row.name}</Link>
                <span>
                  {row.owner} ·{" "}
                  {new Date(row.started_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                <small>
                  {compact(row.steps)} steps · {compact(row.training_tokens)}{" "}
                  tokens · train loss {format(row.train_loss)}
                </small>
              </td>
              <td className="lb-number">
                <strong>{format(row.val_loss)}</strong>
              </td>
              <td className="lb-number">{format(row.perplexity)}</td>
              <td className="lb-number">{compact(row.throughput)}</td>
              <td>
                {row.auto_benchmark ? (
                  <>
                    <span className="lb-benchmark-label">
                      {row.auto_benchmark.label}
                    </span>
                    <strong>
                      {row.auto_benchmark.state === "finished" &&
                      finite(row.auto_benchmark.score)
                        ? row.auto_benchmark.is_percent
                          ? `${format(row.auto_benchmark.score * 100, 1)}%`
                          : format(row.auto_benchmark.score, 2)
                        : row.auto_benchmark.state}
                    </strong>
                  </>
                ) : (
                  <span className="lb-muted">Not evaluated</span>
                )}
              </td>
              <td>
                <details className="lb-mix">
                  <summary>
                    {row.mix.length
                      ? `${row.mix.length} data source${row.mix.length === 1 ? "" : "s"}`
                      : "Not recorded"}
                  </summary>
                  {row.mix.map((item, i) => (
                    <div key={i}>
                      {item.name} <strong>{format(item.weight, 0)}%</strong>
                    </div>
                  ))}
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeaderboardPage() {
  const navigate = useNavigate();
  const { query } = useCustom<{ sizes: LeaderSize[] }>({
    url: "/api/leaderboard",
    method: "get",
  });
  const [sizeKey, setSizeKey] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("val_loss");
  const [groupBy, setGroupBy] = useState<GroupBy>("recipe");
  const [groupFilter, setGroupFilter] = useState("all");
  const [axis, setAxis] = useState<Axis>("training_tokens");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sizes = query.data?.data.sizes || [];
  const size = sizes.find((item) => item.model_size === sizeKey) || sizes[0];
  const models = sizes.flatMap((item) => item.models);
  const searchedRows = sortModels(
    (size?.models || []).filter((row) =>
      [row.name, row.owner, ...row.mix.map((item) => item.name)]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
    ),
    sort,
  );
  const availableGroups = groupModels(searchedRows, groupBy);
  const rows =
    groupFilter === "all"
      ? searchedRows
      : availableGroups.find((group) => group.key === groupFilter)?.rows || [];
  const groups = groupModels(rows, groupBy);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="leaderboard-page">
      <div className="lb-intro">
        <div>
          <div className="lb-eyebrow">Fabryka research / Training results</div>
          <h1>Small models. Measured progress.</h1>
          <p>
            Explore published runs by scale and data recipe. Follow the results
            back to the experiment.
          </p>
        </div>
        <Link className="secondary" to="/new">
          New training run ↗
        </Link>
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
          Loading published results…
        </div>
      ) : !sizes.length ? (
        <div className="lb-empty">
          <h2>No published results yet.</h2>
          <p>
            Finish a training run and publish its validation metrics to appear
            here.
          </p>
          <Link className="primary" to="/new">
            Start a training run
          </Link>
        </div>
      ) : (
        <>
          <div className="lb-stats">
            <div>
              <strong>{models.length}</strong>
              <span>Published runs</span>
            </div>
            <div>
              <strong>{sizes.length}</strong>
              <span>Model sizes</span>
            </div>
            <div>
              <strong>{new Set(models.map((row) => row.owner)).size}</strong>
              <span>Contributors</span>
            </div>
            <div>
              <strong>Measured</strong>
              <span>Saved-checkpoint validation</span>
            </div>
          </div>
          <div className="lb-section-heading">
            <span className="lb-eyebrow">01 / Choose a model size</span>
            <span className="lb-muted">Results stay within one size</span>
          </div>
          <div className="lb-sizes" role="group" aria-label="Model size">
            {sizes.map((item) => (
              <button
                key={item.model_size}
                aria-pressed={size === item}
                onClick={() => {
                  setSizeKey(item.model_size);
                  setGroupFilter("all");
                  setSelected(new Set());
                }}
              >
                <strong>{item.model_size.toUpperCase()}</strong>
                <span>{compact(item.parameters)} parameters</span>
                <small>
                  {item.models.length} published runs{" "}
                  <span aria-hidden="true">↗</span>
                </small>
              </button>
            ))}
          </div>
          <div className="lb-controls">
            <label className="lb-search">
              Find a run
              <input
                type="search"
                placeholder="Search models, authors or datasets…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setGroupFilter("all");
                }}
              />
            </label>
            <label>
              Group by
              <select
                value={groupBy}
                onChange={(event) => {
                  setGroupBy(event.target.value as GroupBy);
                  setGroupFilter("all");
                }}
              >
                <option value="recipe">Data recipe</option>
                <option value="owner">Author</option>
                <option value="none">All runs</option>
              </select>
            </label>
            <label>
              Show group
              <select
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
              >
                <option value="all">
                  All groups ({availableGroups.length})
                </option>
                {availableGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.label} ({group.rows.length})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Order runs by
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="val_loss">Validation loss ↑</option>
                <option value="perplexity">Perplexity ↑</option>
                <option value="throughput">Throughput ↓</option>
                <option value="started_at">Newest first</option>
              </select>
            </label>
          </div>
          <figure className="lb-figure">
            <figcaption>
              <div>
                <span className="lb-eyebrow">02 / Results at a glance</span>
                <h2>Loss vs. training budget</h2>
              </div>
              <span className="lb-stamp">
                Observed results · {size?.model_size.toUpperCase()}
              </span>
            </figcaption>
            <div className="lb-chart-toolbar">
              <p>Saved-checkpoint loss · lower is better</p>
              <label>
                Horizontal axis
                <select
                  value={axis}
                  onChange={(event) => setAxis(event.target.value as Axis)}
                >
                  {Object.entries(axisLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ResultsChart rows={rows} groupBy={groupBy} axis={axis} />
            <p className="lb-chart-note">
              {axis === "estimated_flops"
                ? "Compute is estimated as 6 × parameters × recorded training tokens; it is not a hardware measurement. "
                : ""}
              The budget is the full run; loss is from its saved checkpoint.
              Validation data can differ between runs. Points are observations,
              not a fitted scaling curve.
            </p>
          </figure>
          <div className="lb-results-heading">
            <div>
              <span className="lb-eyebrow">03 / Explore the experiments</span>
              <h2>
                {groupBy === "recipe"
                  ? "Results by data recipe"
                  : groupBy === "owner"
                    ? "Results by author"
                    : "All training results"}
              </h2>
              <p>
                {rows.length} runs · {groups.length}{" "}
                {groups.length === 1 ? "group" : "groups"} ·{" "}
                {size?.model_size.toUpperCase()}
              </p>
            </div>
            <div className="lb-compare">
              <span aria-live="polite">
                {selected.size} selected
                {[...selected].some((id) => !rows.some((row) => row.id === id))
                  ? " (including hidden runs)"
                  : ""}
              </span>
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
                disabled={selected.size < 2}
                onClick={() =>
                  navigate(
                    `/compare/${[...selected].join(",")}?metric=val%2Fperplexity`,
                  )
                }
              >
                Compare runs ↗
              </button>
            </div>
          </div>
          <p className="lb-group-note">
            {groupBy === "recipe"
              ? "Public recipes match on dataset names and weights. Private recipes are pooled by disclosure status, not dataset identity."
              : "Groups organize runs; they do not establish a shared evaluation protocol."}{" "}
            Compare loss only with the same validation data and settings.
          </p>
          {!rows.length ? (
            <div className="lb-empty">
              <h2>No matching runs.</h2>
              <button
                className="secondary"
                onClick={() => {
                  setSearch("");
                  setGroupFilter("all");
                }}
              >
                Clear search
              </button>
            </div>
          ) : (
            groups.map((group, index) => (
              <details
                className="lb-group"
                key={`${size?.model_size}-${groupBy}-${group.key}`}
                id={`lb-group-${index}`}
                open={index < 3}
              >
                <summary>
                  <span
                    className="lb-group-swatch"
                    style={{ background: colors[index % colors.length] }}
                  />
                  <span className="lb-group-title">
                    <strong>{group.label}</strong>
                    <small>{group.detail}</small>
                  </span>
                  <span className="lb-group-count">
                    {group.rows.length}{" "}
                    {group.rows.length === 1 ? "run" : "runs"}
                  </span>
                  <span className="lb-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </summary>
                <RunTable
                  rows={group.rows}
                  selected={selected}
                  toggle={toggle}
                />
              </details>
            ))
          )}
          <p className="lb-footnote">
            Studio validation results are smoke tests. Benchmark labels identify
            separate evaluation suites; their scores should not be ranked
            together.
          </p>
        </>
      )}
    </div>
  );
}
