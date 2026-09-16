import { useMemo, useRef, useState } from "react";
import { useCustom } from "@refinedev/core";
import { request } from "../provider";
import {
  comparisonGroups,
  format,
  plMargin,
  plDiverges,
  TASK_LANG,
  LANG_META,
  type PublishedReport,
  type ComparisonRow,
} from "./PublicBenchmarkModel";
import methodology from "./PublicMethodology.html?raw";
import polishCaveats from "./PublicPolishCaveats.html?raw";
interface ReportsPage {
  items: PublishedReport[];
  total: number;
}
const number = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "Not recorded";
const metrics = [
  ["acc_norm", "Length-normalized accuracy · acc_norm"],
  ["accuracy", "Accuracy · acc"],
  ["index", "INT Index"],
  ["elo", "Fixed-item Overall Elo"],
  ["bpb", "Bits per UTF-8 byte · lower is better"],
];
const fullColumns = [
  ["INT Index", "int_index", "index"],
  ["ARC Easy", "arc_easy", "acc_norm"],
  ["ARC Challenge", "arc_challenge", "acc_norm"],
  ["PIQA", "piqa", "acc_norm"],
  ["HellaSwag", "hellaswag", "acc_norm"],
  ["ArithMark 3", "arithmark3", "acc_norm"],
  ["ArithMark 2", "arithmark2", "accuracy"],
  ["BananaMind 1.1", "bananamind_base_1_1", "elo"],
];
const plColumns = [
  ["pl_induction · cross-check", "pl_induction", "accuracy"],
  ["pl_lm BPB · diagnostic", "pl_lm", "bpb"],
  ["pl_multiblimp · diagnostic", "pl_multiblimp", "accuracy"],
];
function PublishedRanking({
  rows,
  polish = false,
}: {
  rows: ComparisonRow[];
  polish?: boolean;
}) {
  const columns = polish ? plColumns : fullColumns;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Model</th>
            {polish && <th>MultiBLiMP-PL margin</th>}
            {columns.map(([label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ report }, index) => {
            const primary = report.measurements.find(
              (m) => m.task === "multiblimp_polish" && m.metric === "accuracy",
            );
            const crosscheck = report.measurements.find(
              (m) => m.task === "pl_induction" && m.metric === "accuracy",
            );
            const flag = plDiverges(primary, crosscheck),
              margin = plMargin(primary);
            return (
              <tr key={report.id}>
                <td>{index + 1}</td>
                <td>
                  <a href={report.run_url}>{report.run_name}</a>
                  <br />
                  <small>
                    {report.model_size} · {report.owner}
                  </small>
                </td>
                {polish && (
                  <td
                    title={
                      flag
                        ? "Rank margin and pl_induction cross-check disagree in direction — ranking validity questionable"
                        : undefined
                    }
                  >
                    {flag ? "Flagged: " : ""}
                    {margin === null
                      ? "—"
                      : (margin >= 0 ? "+" : "") + margin.toFixed(3)}
                  </td>
                )}
                {columns.map(([, task, metric]) => (
                  <td key={task}>
                    {format(
                      report.measurements.find(
                        (m) => m.task === task && m.metric === metric,
                      ) || {},
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function CheckpointReport({ report: r }: { report: PublishedReport }) {
  const cp = r.checkpoint,
    p = r.evidence;
  const evidence = {
    ...p,
    datasets: r.measurements.map((m) => ({
      benchmark: m.benchmark,
      metric: m.metric,
      sample_digest: m.sample_digest,
      dataset_revisions: m.dataset_revisions,
      task_versions: m.task_versions,
      splits: m.splits,
    })),
  };
  const date = r.ended_at || r.created_at;
  return (
    <article className="panel report" id={"evaluation-" + r.id}>
      <div className="report-heading">
        <div>
          <div className="eyebrow">
            {r.owner} · {r.model_size || "Size not recorded"} ·{" "}
            {number(cp.parameters)} parameters
          </div>
          <h3>
            <a href={r.run_url}>{r.run_name}</a>
          </h3>
          <small>
            Checkpoint step {number(cp.checkpoint_step)} · evaluated{" "}
            {date
              ? new Date(
                  date + (/Z|[+-]\d\d:\d\d$/.test(date) ? "" : "Z"),
                ).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })
              : "Not recorded"}
          </small>
        </div>
        <span className="report-tag">
          {r.mode === "full" ? "Full evaluation" : "Smoke test · diagnostic"}
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <caption
            className="muted"
            style={{ textAlign: "left", paddingBottom: 10 }}
          >
            Recorded checkpoint results
          </caption>
          <thead>
            <tr>
              <th>Benchmark</th>
              <th>Result</th>
              <th>Metric</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {r.measurements.length ? (
              r.measurements.map((m, index) => {
                const language = LANG_META[TASK_LANG[m.task]];
                return (
                  <tr key={index}>
                    <td>
                      {m.benchmark}
                      {language && (
                        <span
                          className="lang-badge"
                          title={language[1]}
                          style={{
                            background: language[2],
                            color: "#fff",
                            fontSize: 11,
                            padding: "1px 6px",
                            borderRadius: 10,
                            marginLeft: 6,
                            verticalAlign: "middle",
                          }}
                        >
                          {language[0]}
                        </span>
                      )}
                    </td>
                    <td>{format(m)}</td>
                    <td className="metric-label">{m.metric_label}</td>
                    <td>
                      {number(m.samples)}
                      {m.sample_unit !== "examples"
                        ? " " + (m.sample_unit || "")
                        : ""}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={4}>No supported numeric metrics were recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <details className="evidence">
        <summary>Checkpoint &amp; evaluation evidence</summary>
        <dl>
          <dt>Checkpoint SHA-256</dt>
          <dd>{cp.checkpoint_sha256 || "Not recorded"}</dd>
          <dt>Training tokens</dt>
          <dd>
            {number(cp.training_tokens)} {cp.token_unit}
          </dd>
          <dt>Context length</dt>
          <dd>
            {number(cp.context_length)} {cp.token_unit || "tokens"}
          </dd>
          <dt>Harness</dt>
          <dd>{p.harness_version || "Not recorded"}</dd>
          <dt>Few-shot / seed</dt>
          <dd>
            {number(p.fewshot)} / {number(p.seed)}
          </dd>
          <dt>Scoring</dt>
          <dd>{p.scoring || "Not recorded"}</dd>
        </dl>
        <pre>{JSON.stringify(evidence, null, 2)}</pre>
      </details>
      <div className="report-links">
        <a href={r.run_url}>Open model &amp; try inference →</a>
        <a href={r.source_url} download={"benchmark-" + r.id + ".json"}>
          Download result JSON ↓
        </a>
      </div>
    </article>
  );
}
export function PublishedBenchmarksPage() {
  const [mode, setMode] = useState("full"),
    [search, setSearch] = useState(""),
    [size, setSize] = useState(""),
    [taskChoice, setTask] = useState(""),
    [metricChoice, setMetric] = useState("acc_norm"),
    [cohort, setCohort] = useState(""),
    [page, setPage] = useState(0),
    [announcement, setAnnouncement] = useState("");
  const resultsElement = useRef<HTMLDivElement>(null);
  const reportsQuery = useCustom<ReportsPage>({
    url: "/api/benchmark-results?mode=" + mode,
    method: "get",
    queryOptions: {
      queryKey: ["published-benchmark-results", mode],
      queryFn: async ({ signal }) => {
        const items: PublishedReport[] = [];
        let offset = 0,
          total = 0;
        do {
          const data = await request<ReportsPage>(
            "/api/benchmark-results?mode=" +
              mode +
              "&limit=100&offset=" +
              offset,
            { signal },
          );
          items.push(...data.items);
          offset += data.items.length;
          total = data.total;
          if (!data.items.length) break;
        } while (offset < total);
        return { data: { items, total } };
      },
    },
  });
  const campaign = useCustom<{
    total: number;
    states: {
      finished: number;
      running: number;
      queued: number;
      failed: number;
    };
  }>({
    url: "/api/benchmark-results/campaign-status",
    method: "get",
    queryOptions: { refetchInterval: 30000 },
  });
  const reports = reportsQuery.query.data?.data?.items || [];
  const matching = useMemo(
    () =>
      reports.filter(
        (report) =>
          (!size || report.model_size === size) &&
          (!search.trim() ||
            (report.run_name + " " + report.owner)
              .toLowerCase()
              .includes(search.toLowerCase().trim())),
      ),
    [reports, size, search],
  );
  const names = new Map(
    matching.flatMap((report) =>
      report.measurements.map((m) => [m.task, m.benchmark] as const),
    ),
  );
  const tasks = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const task = names.has(taskChoice)
    ? taskChoice
    : names.has("int_index")
      ? "int_index"
      : names.has("piqa")
        ? "piqa"
        : tasks[0]?.[0] || "";
  const available = new Set(
    matching.flatMap((report) =>
      report.measurements.filter((m) => m.task === task).map((m) => m.metric),
    ),
  );
  const metric = available.has(metricChoice)
    ? metricChoice
    : metrics.find(([value]) => available.has(value))?.[0] || "";
  const groups = comparisonGroups(matching, task, metric),
    selected =
      groups.find(([key]) => key === cohort)?.[1] || groups[0]?.[1] || [],
    selectedKey =
      groups.find(([key]) => key === cohort)?.[0] || groups[0]?.[0] || "";
  const visible = selected.slice(0, 12),
    first = visible[0];
  const min = visible.length
      ? Math.min(
          0,
          Math.floor(Math.min(...visible.map((row) => row.measurement.value!))),
        )
      : 0,
    max =
      first?.measurement.unit === "percent"
        ? 1
        : Math.max(
            1,
            Math.ceil(
              Math.max(...visible.map((row) => row.measurement.value!)),
            ),
          );
  const ranked =
      mode === "full"
        ? comparisonGroups(matching, "int_index", "index")[0]?.[1] || []
        : [],
    rankedPL =
      mode === "full"
        ? comparisonGroups(matching, "multiblimp_polish", "accuracy")[0]?.[1] ||
          []
        : [];
  const pageCount = Math.ceil(matching.length / 6),
    currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const state = campaign.query.data?.data;
  return (
    <div className="public-benchmarks">
      <section className="intro">
        <div className="eyebrow">Public model evaluations</div>
        <h1>Published benchmark results</h1>
        <p className="muted">
          Recorded evaluations of saved checkpoints from public Track runs.
          Inspect the scores, the metric used and the evidence behind each
          result.
        </p>
        <div className="actions">
          <a className="primary" href="#results">
            Explore results ↓
          </a>
          <a className="secondary" href="/benchmarks">
            Evaluate your model →
          </a>
        </div>
        {Boolean(state?.total) && (
          <p className="muted" role="status">
            Full benchmark campaign: {state?.states.finished} / {state?.total}{" "}
            checkpoints complete · {state?.states.running} running ·{" "}
            {state?.states.queued} queued
            {state?.states.failed
              ? " · " + state.states.failed + " failed"
              : ""}
            . Jobs use our existing GPU when it is available.
          </p>
        )}
      </section>
      {reportsQuery.query.isLoading ? (
        <p role="status">Loading published results…</p>
      ) : reportsQuery.query.isError ? (
        <div className="load-error" role="alert">
          Could not load published results.{" "}
          <button
            className="secondary"
            onClick={() => void reportsQuery.query.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <section className="stats" aria-label="Published evaluation coverage">
            {[
              [
                matching.length,
                mode === "full" ? "full evaluations" : "smoke evaluations",
              ],
              [
                new Set(
                  matching.map(
                    (r) => r.checkpoint.checkpoint_sha256 || r.run_id,
                  ),
                ).size,
                "saved checkpoints",
              ],
              [
                new Set(
                  matching.flatMap((r) => r.measurements.map((m) => m.task)),
                ).size,
                "benchmark tasks with results",
              ],
            ].map(([value, label]) => (
              <div className="stat" key={label}>
                <strong>{value}</strong>
                <small>{label}</small>
              </div>
            ))}
          </section>
          <section aria-label="Filter published results" className="filters">
            <label>
              <span>Model or author</span>
              <input
                id="model-search"
                type="search"
                placeholder="Search public models…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              <span>Model size</span>
              <select
                id="size-filter"
                value={size}
                onChange={(e) => {
                  setSize(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All sizes</option>
                {[
                  ...new Set(
                    reports
                      .map((r) => r.model_size)
                      .filter(
                        (value): value is string =>
                          typeof value === "string" && value.length > 0,
                      ),
                  ),
                ]
                  .sort((a, b) => parseFloat(a) - parseFloat(b))
                  .map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Evaluation scope</span>
              <select
                id="mode-filter"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setPage(0);
                  setSize("");
                }}
              >
                <option value="full">Full evaluations</option>
                <option value="smoke">Smoke tests · diagnostics</option>
              </select>
            </label>
          </section>
          <p
            id="control-status"
            role="status"
            aria-live="polite"
            className="muted"
          >
            Showing {matching.length} report{matching.length === 1 ? "" : "s"} ·
            scope {mode} · Polish board: {rankedPL.length} model
            {rankedPL.length === 1 ? "" : "s"}
            {announcement ? " · " + announcement : ""}
          </p>
          {mode === "smoke" && (
            <p className="smoke-notice">
              Smoke tests use small samples to check that evaluation runs. They
              are not a model-quality ranking.
            </p>
          )}
          {ranked.length > 0 && (
            <section
              className="panel"
              id="full-leaderboard"
              aria-labelledby="full-leaderboard-title"
            >
              <h2 id="full-leaderboard-title">Full-suite leaderboard</h2>
              <p className="muted">
                Completed checkpoints in the largest matching evaluation setup,
                ranked by INT Index. All component scores are required.
              </p>
              <PublishedRanking rows={ranked} />
            </section>
          )}
          {rankedPL.length > 0 && (
            <section
              className="panel"
              id="pl-leaderboard"
              aria-labelledby="pl-leaderboard-title"
            >
              <h2 id="pl-leaderboard-title">Polish leaderboard</h2>
              <div dangerouslySetInnerHTML={{ __html: polishCaveats }} />
              <PublishedRanking rows={rankedPL} polish />
            </section>
          )}
          <section
            className="panel"
            id="comparison"
            aria-labelledby="comparison-title"
          >
            <div className="eyebrow">Compare a recorded metric</div>
            <h2 id="comparison-title">Checkpoint comparison</h2>
            <p className="muted">
              Compare one benchmark and one metric at a time. Results with
              different recorded evaluation setups are kept in separate groups.
            </p>
            <div className="chart-controls">
              <label>
                <span>Benchmark</span>
                <select
                  id="benchmark-filter"
                  value={task}
                  onChange={(event) => {
                    setTask(event.target.value);
                    setAnnouncement(
                      "Comparison benchmark: " + event.target.value,
                    );
                  }}
                >
                  {tasks.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Metric</span>
                <select
                  id="metric-filter"
                  value={metric}
                  onChange={(event) => {
                    setMetric(event.target.value);
                    setAnnouncement("Comparison updated");
                  }}
                >
                  {metrics.map(([value, label]) => (
                    <option
                      key={value}
                      value={value}
                      disabled={!available.has(value)}
                    >
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {groups.length > 1 && mode !== "smoke" && (
              <label>
                <span>Recorded evaluation setup</span>
                <select
                  id="cohort-filter"
                  value={selectedKey}
                  onChange={(event) => {
                    setCohort(event.target.value);
                    setAnnouncement("Comparison updated");
                  }}
                >
                  {groups.map(([key, rows], index) => (
                    <option key={key} value={key}>
                      Setup {index + 1} · {rows.length} checkpoints ·{" "}
                      {number(rows[0].measurement.samples)}{" "}
                      {rows[0].measurement.sample_unit || "examples"} · harness{" "}
                      {rows[0].report.evidence.harness_version}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div id="comparison-chart" aria-live="polite">
              {mode === "smoke" ? (
                <p className="muted">
                  Smoke measurements are available in the checkpoint tables
                  below. Use full evaluations for model comparisons.
                </p>
              ) : !first ? (
                <p className="muted">
                  {matching.some((r) =>
                    r.measurements.some(
                      (m) => m.task === task && m.metric === metric,
                    ),
                  )
                    ? "These results lack some of the provenance needed to group a comparison. Their recorded values remain in the tables below."
                    : "No recorded results for this benchmark and metric in the selected models. Choose another metric or benchmark."}
                </p>
              ) : (
                <>
                  <p className="chart-protocol">
                    {first.report.evidence.protocol} ·{" "}
                    {number(first.measurement.samples)}{" "}
                    {first.measurement.sample_unit || "examples"} ·{" "}
                    {first.report.evidence.fewshot}-shot ·{" "}
                    {first.measurement.higher_is_better ? "higher" : "lower"} is
                    better · scale {min}–
                    {first.measurement.unit === "percent" ? "100%" : max}
                  </p>
                  {visible.map(({ report, measurement }) => (
                    <div className="chart-row" key={report.id}>
                      <div className="chart-name">
                        <a href={report.run_url}>{report.run_name}</a>
                        <small>
                          {report.owner} · {report.model_size} · step{" "}
                          {number(report.checkpoint.checkpoint_step)}
                        </small>
                      </div>
                      <div className="bar-track" aria-hidden="true">
                        <div
                          className="bar-fill"
                          style={{
                            marginLeft:
                              ((Math.min(0, measurement.value!) - min) /
                                (max - min)) *
                                100 +
                              "%",
                            width:
                              (Math.abs(measurement.value!) / (max - min)) *
                                100 +
                              "%",
                          }}
                        />
                      </div>
                      <span className="chart-value">{format(measurement)}</span>
                    </div>
                  ))}
                  <p className="chart-note">
                    {selected.length > 12
                      ? "Top 12 of " + selected.length
                      : selected.length}{" "}
                    checkpoints in this recorded setup. The latest result per
                    checkpoint is used. Other setups and results without
                    complete comparison evidence remain in the reports below.
                  </p>
                </>
              )}
            </div>
          </section>
          <div ref={resultsElement} className="section-title" id="results">
            <h2>Checkpoint reports</h2>
            <small>{matching.length} reports · newest first</small>
          </div>
          <section id="reports" aria-label="Checkpoint benchmark tables">
            {matching.length ? (
              matching
                .slice(currentPage * 6, (currentPage + 1) * 6)
                .map((report) => (
                  <CheckpointReport key={report.id} report={report} />
                ))
            ) : (
              <div className="panel empty">
                <h3>No matching published results</h3>
                <p className="muted">
                  Try another model or evaluation scope. Completed evaluations
                  appear here when their run is public.
                </p>
                <a href="/benchmarks">Open the evaluation studio →</a>
              </div>
            )}
          </section>
          <div className="pager">
            <button
              className="secondary"
              disabled={currentPage === 0}
              onClick={() => {
                setPage(currentPage - 1);
                resultsElement.current?.scrollIntoView();
              }}
            >
              ← Previous
            </button>
            <span>
              {matching.length
                ? `Page ${currentPage + 1} of ${pageCount}`
                : "0 reports"}
            </span>
            <button
              className="secondary"
              disabled={(currentPage + 1) * 6 >= matching.length}
              onClick={() => {
                setPage(currentPage + 1);
                resultsElement.current?.scrollIntoView();
              }}
            >
              Next →
            </button>
          </div>
        </>
      )}
      <div dangerouslySetInnerHTML={{ __html: methodology }} />
      <footer>
        Fabryka Track · Published measurements with checkpoint evidence.
      </footer>
    </div>
  );
}
