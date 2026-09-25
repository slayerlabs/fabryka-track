import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MetricHelp } from "./BenchmarkHelp";
import { RunChart, type Series } from "./RunChart";
import {
  activeRun,
  fmt,
  latest,
  RangeControls,
  RunError,
  useRunAction,
  useRunQuery,
  type Run,
} from "./RunData";
import { RunStatus } from "./RunStatus";
import {
  RunArtifact,
  RunNamespace,
  RunSampler,
  SampleOutput,
  type Sample,
} from "./RunPanels";
import { RunExport } from "./RunExport";
import { RunBenchmarks } from "./RunBenchmarks";
import { WhiteBenchmark } from "./WhiteBenchmark";

const metricNames: Record<string, string> = {
  "throughput/tokens_sec": "Training throughput",
  "training/tokens_seen": "Training tokens",
  "optimizer/learning_rate": "Learning rate",
  "optimizer/gradient_norm": "Gradient norm (before clipping)",
  "optimizer/gradient_norm_after_clip": "Gradient norm (after clipping)",
  "optimizer/gradient_clip_threshold": "Gradient clipping threshold",
  "optimizer/gradient_clipped": "Gradient clipped (0 / 1)",
  "grad_norm": "Gradient norm",
  "train/grad_norm": "Gradient norm",
  "gradient_norm": "Gradient norm",
  "checkpoint/tokens": "Saved checkpoint · tokens",
  "checkpoint/step": "Saved checkpoint · step",
  "validation/bpb": "Validation bits per byte",
};
const externalOrder = [
  "throughput/tokens_sec",
  "optimizer/learning_rate",
  "optimizer/gradient_norm",
  "training/tokens_seen",
  "checkpoint/tokens",
  "checkpoint/step",
];
export function RunDetailPage() {
  const { id = "" } = useParams();
  return <RunWorkspace key={id} id={id} />;
}
function RunWorkspace({ id }: { id: string }) {
  const query = useRunQuery<Run>(
    "/api/runs/" + encodeURIComponent(id),
    (data) => (!data || activeRun(data) ? 2000 : false),
  );
  const [tab, setTab] = useState("charts");
  const [namespaceVisited, setNamespaceVisited] = useState(false);
  const [filter, setFilter] = useState("");
  const [range, setRange] = useState(0);
  const [layout, setLayout] = useState("grid");
  const [sample, setSample] = useState<Sample>();
  const exportHost = useRef<HTMLDivElement>(null);
  const action = useRunAction();
  const navigate = useNavigate();
  const r = query.data;
  if (!r)
    return (
      <>
        <RunError error={query.error} retry={() => void query.refetch()} />
        {query.isLoading && <p role="status">Loading workspace…</p>}
      </>
    );
  const readOnly = !!r.read_only,
    local = r.metadata.engine === "tiny-transformer",
    external = r.metadata.engine === "external-training";
  const finished = r.state === "finished",
    active = activeRun(r),
    result = r.metadata.training_result;
  const model = r.config.model || "Tiny transformer · 134,912 parameters";
  const cards: [string, number | undefined][] = [
    ["Training loss", latest(r, "train/loss") ?? latest(r, "loss")],
    [
      external ? "Training tokens (M)" : "Validation loss",
      external
        ? (latest(r, "training/tokens_seen") || 0) / 1e6
        : latest(r, "val/loss"),
    ],
    [
      external ? "Checkpoint tokens (M)" : "Validation perplexity",
      external
        ? (r.metadata.tracking?.checkpoint?.tokens || 0) / 1e6
        : latest(r, "val/perplexity"),
    ],
    [
      external ? "Tokenizer tokens / sec" : "Byte tokens / sec",
      latest(r, "throughput/tokens_sec"),
    ],
  ];
  const charts: { key: string; title: string; series: Series[] }[] = [
    {
      key: "learning",
      title: "Learning progress",
      series: [
        {
          name: "Training loss",
          points: r.metrics["train/loss"] || r.metrics.loss || [],
        },
        { name: "Validation loss", points: r.metrics["val/loss"] || [] },
      ],
    },
  ];
  if (!external || r.metrics["val/perplexity"]?.length)
    charts.push({
      key: "val/perplexity",
      title: "Validation perplexity",
      series: [
        { name: "Perplexity", points: r.metrics["val/perplexity"] || [] },
      ],
    });
  const additional = Object.entries(r.metrics).filter(
    ([key]) =>
      ![
        "train/loss",
        "loss",
        "val/loss",
        "val/perplexity",
        "progress",
      ].includes(key),
  );
  if (external)
    additional.sort(
      ([a], [b]) =>
        (externalOrder.includes(a) ? externalOrder.indexOf(a) : 99) -
        (externalOrder.includes(b) ? externalOrder.indexOf(b) : 99),
    );
  for (const [key, points] of additional)
    charts.push({
      key,
      title: metricNames[key] || key,
      series: [{ name: key, points }],
    });
  const status =
    r.metadata.gpu_cleanup === "pending"
      ? "Artifacts verified — terminating RunPod…"
      : r.state === "queued"
        ? r.config.compute === "runpod"
          ? "Provisioning RunPod GPU…"
          : "Queued — waiting for the current run"
        : finished
          ? result?.stop_reason === "early_stopping"
            ? "Stopped early — validation stopped improving"
            : "Training complete"
          : r.state === "cancelled"
            ? "Training cancelled"
            : r.state === "interrupted"
              ? "Training interrupted — start a new run to retry"
              : r.state === "failed"
                ? "Training failed — see the log below"
                : r.state === "stopping"
                  ? "Stopping training…"
                  : "Training in progress";
  return (
    <div className="run-view">
      <Link
        to={readOnly ? "/leaderboard" : "/runs"}
        className="muted"
        style={{
          display: "inline-block",
          marginBottom: 25,
          textDecoration: "none",
        }}
      >
        ← {readOnly ? "Leaderboard" : "My runs"}
      </Link>
      <div className="intro row">
        <div>
          <div className="eyebrow">
            {local ? "Training results" : "Tracked experiment"}
          </div>
          <h1>{r.name}</h1>
          <p className="muted">
            {external
              ? `${model} · ${r.config.tokenizer_vocab_size}-token vocabulary · `
              : local
                ? model +
                  (r.config.compute === "runpod"
                    ? " · RunPod GPU · "
                    : " · Local CPU · ")
                : ""}
            {new Date(r.started_at).toLocaleString()}
          </p>
        </div>
        <span className={"badge " + r.state}>{r.state}</span>
      </div>
      <RunError error={query.error} retry={() => void query.refetch()} />
      <RunError error={action.error} />
      <div className="compare-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "charts"}
          onClick={() => setTab("charts")}
        >
          Charts
        </button>
        {!readOnly && (
          <button
            role="tab"
            aria-selected={tab === "namespace"}
            onClick={() => {
              setNamespaceVisited(true);
              setTab("namespace");
            }}
          >
            Namespace
          </button>
        )}
        {local && finished && (
          <button
            role="tab"
            aria-selected={tab === "samples"}
            onClick={() => setTab("samples")}
          >
            Sample generations
          </button>
        )}
      </div>
      {local && finished && (
        <>
          <section className="panel" id="quick-sample">
            <div className="row">
              <h3>Sample generation</h3>
              <button className="secondary" onClick={() => setTab("samples")}>
                Try this model →
              </button>
            </div>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              A short continuation from this run’s best checkpoint.
            </p>
            <div aria-live="polite">
              {sample ? (
                <SampleOutput sample={sample} />
              ) : (
                <p className="muted">
                  Enter a prompt in the sampler, then generate a continuation.
                </p>
              )}
            </div>
          </section>
          <section
            id="run-samples"
            className="panel"
            hidden={tab !== "samples"}
            style={{ padding: 22, marginTop: 16 }}
          >
            <RunSampler id={id} onSample={setSample} />
          </section>
        </>
      )}
      {!readOnly && (
        <section
          className="panel"
          hidden={tab !== "namespace"}
          style={{ padding: 22, marginTop: 16 }}
        >
          {namespaceVisited && <RunNamespace id={id} />}
        </section>
      )}
      <MetricHelp />
      <div hidden={tab !== "charts"}>
        <RunStatus run={r} />
        <section className="panel" style={{ padding: 20, marginBottom: 16 }} aria-label="Gradient tracking">
          <h3>Gradient tracking</h3>
          <p className="muted">Gradient norm measures the size of the loss gradients used by the optimizer.
            Compare spikes with loss and learning rate; there is no universal healthy range.</p>
          {["optimizer/gradient_norm", "grad_norm", "train/grad_norm", "gradient_norm"].some(key => r.metrics[key]?.length) ? (
            <p>Latest gradient norm: <strong>{fmt(latest(r, "optimizer/gradient_norm") ?? latest(r, "grad_norm") ?? latest(r, "train/grad_norm") ?? latest(r, "gradient_norm"), 4)}</strong>.
              See the gradient charts below. Clipped = 1 means the recorded step exceeded the clipping threshold;
              sampled points do not measure clipping frequency across all updates.</p>
          ) : (
            <p>No gradient measurements were recorded. Send <code>optimizer/gradient_norm</code> from the trainer
              after backward and before clipping. Loss alone cannot reconstruct past gradients.</p>
          )}
          <details><summary>How to record gradients</summary>
            <p>Record the global L2 norm at optimizer-update boundaries, after gradient accumulation.
              With mixed-precision loss scaling, unscale gradients before measuring or clipping.
              PyTorch <code>clip_grad_norm_</code> returns the norm before clipping; log that existing result
              at your normal reporting interval. For sharded training, use your framework’s global norm.</p>
          </details>
        </section>
        {local && (
          <>
            <div className="row">
              <small>{status}</small>
              <small>
                {fmt(latest(r, "progress") || 0, 0)}% · step{" "}
                {r.metrics.progress?.at(-1)?.step || 0} / {r.config.steps}
              </small>
            </div>
            <progress
              max="100"
              value={latest(r, "progress") || 0}
              aria-label="Training progress"
            />
          </>
        )}
        <div className="metrics">
          {cards.map(([name, value]) => (
            <div className="metric" key={name}>
              <small>{name}</small>
              <strong>{fmt(value)}</strong>
            </div>
          ))}
        </div>
        {result && finished && (
          <div className="notice">
            Saved best model from step {result.best_step}: validation loss{" "}
            {fmt(result.best_val_loss, 4)}, perplexity{" "}
            {fmt(result.best_val_perplexity)}. Completed{" "}
            {result.completed_steps} of {r.config.steps} maximum updates. The
            curves and metric cards show training history; model.pt contains the
            best checkpoint.
          </div>
        )}
        <div className="metric-explorer">
          <div>
            <h2>Metric explorer</h2>
            <small>
              Hover to inspect · drag to zoom ·{" "}
              <Link to="/guide">How to read these charts? →</Link>
            </small>
          </div>
          <div className="explorer-controls">
            <input
              type="search"
              aria-label="Filter metrics"
              placeholder="Find a metric…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <RangeControls
              range={range}
              setRange={setRange}
              layout={layout}
              setLayout={setLayout}
            />
          </div>
        </div>
        <div
          className="charts"
          style={{
            gridTemplateColumns: layout === "column" ? "1fr" : undefined,
          }}
        >
          {charts.map((chart) => (
            <div
              className="chart"
              key={chart.key}
              hidden={!chart.title.toLowerCase().includes(filter.toLowerCase())}
            >
              <h3>{chart.title}</h3>
              <RunChart series={chart.series} range={range} />
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 15 }}>
          {external
            ? "Loss is measured per tokenizer token. Source events have no timestamps; use tokens or steps to inspect the history. Throughput measures updates and excludes checkpoint overhead."
            : "Lower loss and perplexity mean better next-byte predictions. Compare runs with the same validation data."}{" "}
          {active && "Refreshes every 2 seconds."}
        </p>
      </div>
      {!readOnly && (
        <div className="checkpoint-protocol-note">
          <Link
            className="runs-button runs-button-secondary"
            to={`/checkpoints?run=${encodeURIComponent(id)}`}
          >
            Monitor checkpoints · WikiText-2 validation / test
          </Link>
          <p>
            Evaluate compatible saved snapshots while training continues, or
            review a weights-only fork. No evaluation or training is launched by
            opening this page.
          </p>
        </div>
      )}
      <WhiteBenchmark id={id} />
      {finished && <RunBenchmarks id={id} canEvaluate={!readOnly && local} />}
      <div className="actions">
        <div>
          {!readOnly && local && active && (
            <button
              className="secondary"
              disabled={action.pending || r.state === "stopping"}
              onClick={async () => {
                if (await action.execute("/api/training/" + id + "/stop"))
                  await query.refetch();
              }}
            >
              Stop training
            </button>
          )}
          {!readOnly && external && active && (
            <button
              className="secondary"
              disabled={action.pending || r.state === "stopping"}
              onClick={async () => {
                if (await action.execute("/api/external-training/" + id + "/stop"))
                  await query.refetch();
              }}
            >
              {r.state === "stopping" ? "Stop requested" : "Stop training"}
            </button>
          )}
          {!readOnly && local && finished && (
            <>
              <button
                className="secondary"
                disabled={action.pending}
                onClick={async () => {
                  if (
                    await action.execute(
                      "/api/training/" + id + "/visibility",
                      { is_public: !r.is_public },
                      "patch",
                    )
                  )
                    await query.refetch();
                }}
              >
                {r.is_public
                  ? "Make run private"
                  : "Share model on leaderboard"}
              </button>
              <button
                className="primary"
                onClick={() => {
                  exportHost.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                  exportHost.current
                    ?.querySelector<HTMLInputElement>('input[name="repo_name"]')
                    ?.focus();
                }}
              >
                Upload to Hugging Face →
              </button>
            </>
          )}
          {!readOnly && (
            <button
              className="secondary"
              disabled={action.pending}
              onClick={async () => {
                if (
                  await action.execute(
                    "/api/runs/" + id + (r.archived ? "/unarchive" : "/archive"),
                  )
                )
                  await query.refetch();
              }}
            >
              {r.archived ? "Unarchive run" : "Archive run"}
            </button>
          )}
          {!readOnly && (
            <button
              className="secondary danger"
              disabled={action.pending}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Delete this run permanently? This removes all its metrics, charts, logs and notes and cannot be undone.",
                  )
                )
                  return;
                if (await action.execute("/api/runs/" + id, {}, "delete"))
                  navigate("/runs");
              }}
            >
              Delete run
            </button>
          )}
          {r.artifacts?.map((artifact) => (
            <RunArtifact key={artifact.id} {...artifact} />
          ))}
        </div>
        {readOnly && (
          <p className="muted">
            {external
              ? "Public training progress · checkpoints are saved on the training host."
              : "Public run · uploaded files and notes remain private."}
          </p>
        )}
        <Link className="secondary" to="/new">
          New training run →
        </Link>
      </div>
      {!readOnly && local && finished && (
        <div ref={exportHost}>
          <RunExport id={id} />
        </div>
      )}
      <details>
        <summary>Dataset mix &amp; settings</summary>
        <div className="panel">
          <pre>{JSON.stringify(r.config, null, 2)}</pre>
        </div>
      </details>
      {!readOnly && (
        <>
          <RunNotes
            run={r}
            onSaved={() => {
              void query.refetch();
            }}
          />
          <details>
            <summary>Training log</summary>
            <div className="panel">
              <pre>
                {r.logs?.map((l) => `[${l.level}] ${l.message}`).join("\n") ||
                  "No logs yet."}
              </pre>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
function RunNotes({ run, onSaved }: { run: Run; onSaved: () => void }) {
  const [note, setNote] = useState(run.note || ""),
    [conclusion, setConclusion] = useState(run.conclusion || "");
  const [saved, setSaved] = useState(false);
  const action = useRunAction();
  return (
    <details>
      <summary>Run notes</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaved(false);
          if (
            await action.execute(
              "/api/runs/" + run.id + "/notes",
              { note, conclusion },
              "patch",
            )
          ) {
            setSaved(true);
            onSaved();
          }
        }}
      >
        <label className="field">
          <span>What are you testing?</span>
          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="field">
          <span>Conclusion</span>
          <textarea
            value={conclusion}
            onChange={(e) => {
              setConclusion(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button className="secondary" disabled={action.pending}>
          Save notes
        </button>
        <RunError error={action.error} />
        {saved && <p role="status">Notes saved.</p>}
      </form>
    </details>
  );
}
