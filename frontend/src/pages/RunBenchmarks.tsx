import { fmt, pct, RunError, useRunAction, useRunQuery } from "./RunData";

type Measurement = {
  error?: string;
  accuracy?: number;
  byte_perplexity?: number;
  random_baseline?: number;
  normalized?: number;
  samples?: number;
  bpb?: number;
  nll?: number;
  mean_margin_nats?: number;
  mean_correct_probability?: number;
};
type Evaluation = {
  id: string;
  mode: string;
  status: string;
  queue_position?: number;
  created_at: string;
  current_task?: string;
  provenance: {
    checkpoint_step?: number;
    training_tokens?: number;
    [key: string]: unknown;
  };
  protocol: string;
  error?: string;
  tiny_score: number | null;
  fast_score?: number;
  tasks: string[];
  results: Record<string, Measurement>;
};
type Catalog = { available: boolean; tasks: { id: string; name: string }[] };
const fastNames: Record<string, string> = {
  fast_lm: "Held-out LM · 40%",
  fast_blimp: "BLiMP-fast · 35%",
  fast_supplement: "BLiMP Supplement · 10%",
  fast_ewok: "EWoK-fast · 5%",
  fast_arc: "ARC-Easy · 10%",
};
export function RunBenchmarks({
  id,
  canEvaluate,
}: {
  id: string;
  canEvaluate: boolean;
}) {
  const history = useRunQuery<Evaluation[]>(
    "/api/runs/" + id + "/benchmarks",
    (data) =>
      data?.some((e) => ["queued", "running"].includes(e.status))
        ? 3000
        : false,
  );
  const catalog = useRunQuery<Catalog>("/api/benchmarks/catalog");
  const action = useRunAction();
  const active = history.data?.some((e) =>
    ["queued", "running"].includes(e.status),
  );
  async function evaluate(suite: string, mode: string) {
    if (
      await action.execute("/api/runs/" + id + "/benchmarks", { suite, mode })
    )
      await history.refetch();
  }
  return (
    <section className="panel" style={{ margin: "24px 0" }}>
      <RunError error={history.error} retry={() => void history.refetch()} />
      <RunError error={catalog.error} retry={() => void catalog.refetch()} />
      <RunError error={action.error} />
      <div className="panel" style={{ marginBottom: 16 }}>
        <b>Polish evaluation ladder</b>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Tokenizer gate → held-out bits-per-byte → MultiBLiMP Polish agreement
          → induction/copy → generation → chance-normalized QA. English-only
          scores are kept separate from Polish model quality.
        </p>
        {canEvaluate && (
          <button
            className="secondary"
            style={{ marginTop: 10 }}
            disabled={action.pending || active || !catalog.data?.available}
            onClick={() => void evaluate("polish", "smoke")}
          >
            Run Polish MultiBLiMP
          </button>
        )}
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Learn while you evaluate:{" "}
          <a
            href="https://huggingface.co/learn/nlp-course/chapter1/1"
            target="_blank"
            rel="noopener noreferrer"
          >
            Hugging Face NLP Course ↗
          </a>{" "}
          ·{" "}
          <a
            href="https://arxiv.org/abs/2203.15556"
            target="_blank"
            rel="noopener noreferrer"
          >
            Chinchilla scaling paper ↗
          </a>{" "}
          ·{" "}
          <a
            href="https://github.com/EleutherAI/lm-evaluation-harness"
            target="_blank"
            rel="noopener noreferrer"
          >
            Evaluation harness docs ↗
          </a>
        </p>
      </div>
      <h2>TinyLM benchmarks</h2>
      <p className="muted">
        English · zero-shot · saved model checkpoint. Short-context byte models
        may score near chance. Smoke tests check the evaluation pipeline: with
        10 examples, one answer moves accuracy by 10 percentage points. Use full
        evaluations to compare quality.
      </p>
      <p>
        TinyScore = mean (accuracy − random) / (1 − random) across SciQ,
        ARC-Easy, PIQA, HellaSwag and BLiMP. Negative values are retained.
        LAMBADA is reported separately: it has no fixed multiple-choice random
        baseline.
      </p>
      {canEvaluate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void evaluate(String(data.get("suite")), String(data.get("mode")));
          }}
        >
          <div className="fields">
            <label className="field">
              <span>Suite</span>
              <select name="suite">
                <option value="tiny_ml">Tiny-ML · private BLiMP + ARC-Easy + WikiText-2</option>
                <option value="fast">
                  Fast ladder EN · 4 ready / EWoK pending
                </option>
                <option value="fast_pl">
                  Fast ladder PL · Polish BPB + agreement + induction
                </option>
                <option value="tinylm">TinyLM · 6 tasks</option>
                <option value="piqa">
                  PIQA only · English physical commonsense
                </option>
                <option value="core">Core · 5 tasks</option>
                <option value="extended">Extended · all 8 tasks</option>
              </select>
            </label>
            <label className="field">
              <span>Evaluation size</span>
              <select name="mode">
                <option value="smoke">
                  Smoke test · 10 examples per subtask
                </option>
                <option value="full">
                  Full suite · fixed sample for Fast ladder
                </option>
              </select>
            </label>
          </div>
          <button
            className="primary"
            disabled={active || action.pending || !catalog.data?.available}
          >
            Run missing benchmarks
          </button>
          {catalog.data && !catalog.data.available && (
            <p>Benchmark worker unavailable.</p>
          )}
        </form>
      )}
      {history.isLoading && (
        <p role="status">Loading benchmark measurements…</p>
      )}
      {history.data?.length === 0 && (
        <p className="muted" style={{ marginTop: 18 }}>
          No benchmark measurements yet.
        </p>
      )}
      {history.data?.map((e) => (
        <div
          key={e.id}
          style={{
            marginTop: 24,
            borderTop: "1px solid var(--line)",
            paddingTop: 20,
          }}
        >
          <div className="row">
            <h3>
              {e.mode === "smoke"
                ? "Smoke test — not a full benchmark"
                : "Full benchmark"}{" "}
              · {e.status}
              {e.queue_position ? " · queue #" + e.queue_position : ""}
            </h3>
            {canEvaluate && ["queued", "running"].includes(e.status) && (
              <button
                className="secondary"
                disabled={action.pending}
                onClick={async () => {
                  if (
                    await action.execute(
                      "/api/runs/" + id + "/benchmarks/" + e.id + "/cancel",
                    )
                  )
                    await history.refetch();
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <p className="muted">
            {new Date(e.created_at).toLocaleString()}
            {e.current_task && " · Evaluating " + e.current_task} · checkpoint
            step {e.provenance?.checkpoint_step ?? "—"} ·{" "}
            {fmt(e.provenance?.training_tokens, 0)} training byte tokens
          </p>
          {e.protocol === "fast-en-v1" && (
            <section
              className="panel"
              style={{ padding: 16, margin: "12px 0" }}
            >
              <b>
                {e.mode === "smoke" ? "Smoke " : ""}FastScore EN:{" "}
                {pct(e.fast_score)}
              </b>
              <small> · Experimental internal score · {e.protocol}</small>
              <table>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Measurements</th>
                    <th>Items / bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(fastNames).map(([key, name]) => {
                    const v = e.results[key] || {};
                    return (
                      <tr key={key}>
                        <td>{name}</td>
                        <td>
                          {key === "fast_ewok" && !v.samples
                            ? "HF access required"
                            : v.error
                              ? v.error
                              : key === "fast_lm"
                                ? `BPB ${fmt(v.bpb, 4)} · NLL ${fmt(v.nll, 4)}`
                                : `Accuracy ${pct(v.accuracy)} · margin ${fmt(v.mean_margin_nats, 4)} nats${v.mean_correct_probability != null ? " · P(correct) " + pct(v.mean_correct_probability) : ""}`}
                        </td>
                        <td>{v.samples ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <small>
                Fixed English diagnostics. Not comparable with TinyScore. Smoke
                checks execution only. External held-out split; training overlap
                has not been audited.
              </small>
            </section>
          )}
          {e.error && (
            <p className="error" role="alert">
              {e.error}
            </p>
          )}
          {e.protocol !== "fast-en-v1" && (
            <p>
              <b>
                {e.mode === "smoke" ? "Smoke TinyScore" : "TinyScore"}:{" "}
                {pct(e.tiny_score)}
              </b>
              {e.tiny_score === null && " · Waiting for all five core tasks."}
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Benchmark</th>
                  <th>Accuracy</th>
                  <th>Random</th>
                  <th>Normalized</th>
                  <th>Examples</th>
                </tr>
              </thead>
              <tbody>
                {e.tasks.map((key) => {
                  const v = e.results[key] || {};
                  return (
                    <tr key={key}>
                      <td>
                        {catalog.data?.tasks.find((t) => t.id === key)?.name ||
                          key}
                      </td>
                      <td>{v.error || (key === "wikitext" ? "Byte PPL " + fmt(v.byte_perplexity, 4) : pct(v.accuracy))}</td>
                      <td>{pct(v.random_baseline)}</td>
                      <td>{pct(v.normalized)}</td>
                      <td>{v.samples ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Protocol, dataset revisions &amp; all metrics</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(
                {
                  protocol: e.protocol,
                  provenance: e.provenance,
                  results: e.results,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      ))}
      <p className="muted">
        Scaling checkpoints: 10M → 30M → 100M → 300M → 1B training tokens.
        Historical points require saved weights at those budgets; they cannot be
        reconstructed from a final checkpoint. FLOPs in protocol metadata are
        estimates (6 × parameters × training tokens).
      </p>
    </section>
  );
}
