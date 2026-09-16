import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { learningExamples } from "./StudioData";

interface GuidePlotly {
  newPlot: (
    element: HTMLElement,
    data: unknown[],
    layout: object,
    config: object,
  ) => Promise<unknown>;
  purge: (element: HTMLElement) => void;
  Plots: { resize: (element: HTMLElement) => void };
}

function ExampleChart({
  example,
}: {
  example: (typeof learningExamples)[number];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = container.current;
    // Plotly is loaded by the application shell's pinned script.
    const chartWindow = window as unknown as { Plotly?: GuidePlotly };
    const plotly = chartWindow.Plotly;
    if (!element || !plotly) {
      setError(
        "The chart library could not be loaded. Reload this page to try again.",
      );
      return;
    }
    let disposed = false;
    void plotly
      .newPlot(
        element,
        [
          {
            name: "Training loss",
            x: example.train.map((_, i) => i * 100),
            y: example.train,
            type: "scatter",
            mode: "lines+markers",
            line: { color: "#b54f2d" },
          },
          {
            name: "Validation loss",
            x: example.val.map((_, i) => i * 100),
            y: example.val,
            type: "scatter",
            mode: "lines+markers",
            line: { color: "#448777" },
          },
        ],
        {
          autosize: true,
          height: 285,
          margin: { l: 45, r: 15, t: 12, b: 65 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          xaxis: { title: { text: "Training step" } },
          yaxis: { title: { text: "Loss" } },
          legend: { orientation: "h", y: -0.25 },
          hovermode: "x unified",
        },
        { responsive: true, displaylogo: false },
      )
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      });
    const observer = new ResizeObserver(() => {
      if (!disposed) plotly.Plots.resize(element);
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      plotly.purge(element);
    };
  }, [example]);
  return (
    <div className="chart">
      {error && <p role="alert">{error}</p>}
      <div
        ref={container}
        aria-label={`${example.title}: illustrative training and validation loss`}
      />
      <div className="muted">
        Final training loss: {example.train.at(-1)} · Final validation loss:{" "}
        {example.val.at(-1)}
      </div>
    </div>
  );
}

export function GuidePage() {
  const [filter, setFilter] = useState("all");
  return (
    <section lang="en" className="learning-guide">
      <div className="intro">
        <div className="eyebrow">Example library</div>
        <h1>How to read model training</h1>
        <p className="muted">
          The lowest training loss does not always mean the best model. Compare
          it with validation and inspect the data.
        </p>
      </div>
      <details
        className="panel guide-notes metric-help"
        open
        style={{ margin: "20px 0" }}
      >
        <summary>
          <strong>What do loss, perplexity, validation and test mean?</strong>
        </summary>
        <div className="guide-grid">
          <article>
            <h3>Training · practice</h3>
            <p>
              The model reads training text and adjusts its weights to get
              better at predicting the next token.{" "}
              <strong>Training loss</strong> measures how surprised it is by the
              correct next tokens. Lower is better on that text, but a model can
              memorize it.
            </p>
          </article>
          <article>
            <h3>Validation · a progress check</h3>
            <p>
              Validation text is held out from weight updates. Track checks it
              during training to decide which checkpoint to save and when to
              stop. <strong>Validation loss</strong> asks: does the model also
              improve on text it is not learning from directly?
            </p>
            <p>
              If training loss keeps falling while validation loss rises, the
              model may be overfitting: learning the practice material without
              improving on unseen text.
            </p>
          </article>
          <article>
            <h3>Test · the final exam</h3>
            <p>
              A test set is separate data kept out of training and model
              selection. Use it after choosing your model and settings to
              estimate performance on new examples. If you repeatedly change the
              model based on a test score, that set becomes part of your
              validation process.
            </p>
            <p>
              Track’s training validation score is{" "}
              <strong>not a final test score</strong>. Benchmarks evaluate a
              saved checkpoint on separate tasks; their value as a final test
              depends on avoiding training overlap and tuning on their results.
            </p>
          </article>
          <article>
            <h3>Perplexity · prediction uncertainty</h3>
            <p>
              Perplexity turns average prediction loss into an easier-to-read
              scale: <strong>perplexity = exp(loss)</strong>. Lower means the
              model assigns more probability to the correct next tokens. For
              example, a loss of about 1.39 gives a perplexity of 4.
            </p>
            <p>
              As an intuition, perplexity 4 is like being equally uncertain
              among four choices at each prediction. It does{" "}
              <strong>not</strong> mean 25% accuracy or four mistakes. Track’s
              studio models predict UTF-8 bytes, so this is uncertainty per
              byte, not per word.
            </p>
            <p>
              Compare perplexity only with the same evaluation text, tokenizer
              and settings. A lower score on easier text does not establish a
              better model.
            </p>
          </article>
        </div>
        <p className="muted">
          <strong>In Track:</strong> training reserves roughly 10% of each
          source’s documents for validation and evaluates a fixed sample. A
          source with fewer than two documents uses a 90/10 byte split instead.
          No third, independent test split is automatically created from your
          training mix. Small validation samples are a diagnostic, not proof of
          general quality.
        </p>
      </details>
      <div className="notice">
        <strong>All charts below are illustrative.</strong> These invented
        series show common patterns; they are not real model measurements or
        benchmarks. The scales illustrate the trends.
      </div>
      <div className="actions guide-filters" aria-label="Filter examples">
        {[
          ["all", "All examples"],
          ["healthy", "Healthy patterns"],
          ["problem", "Warning signs"],
        ].map(([value, label]) => (
          <button
            key={value}
            className="secondary"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
        <Link className="secondary" to="/new">
          Open studio →
        </Link>
      </div>
      <div className="guide-grid">
        {learningExamples
          .filter((example) => filter === "all" || example.group === filter)
          .map((example) => (
            <article className="panel guide-card" key={example.id}>
              <div className="eyebrow">{example.tag}</div>
              <h2>{example.title}</h2>
              <ExampleChart example={example} />
              <p className="muted guide-caption">
                Illustrative data · lowest validation loss at step{" "}
                {example.val.indexOf(Math.min(...example.val)) * 100}. Legend
                values refer to the end of each curve.
              </p>
              <h3>What you see</h3>
              <p>{example.observation}</p>
              <h3>What to do</h3>
              <p>{example.action}</p>
              <details>
                <summary>What to watch for</summary>
                <p>{example.trap}</p>
              </details>
            </article>
          ))}
      </div>
      <section className="panel guide-notes">
        <h2>Three checks before your next run</h2>
        <ol>
          <li>
            <strong>Select checkpoints using validation.</strong> Track saves
            the model with the lowest measured validation loss, while the chart
            also shows later steps. Early stopping ends a run after the
            configured number of evaluations without improvement.
          </li>
          <li>
            <strong>Check the amount of unique data.</strong> The token budget
            counts processed tokens, including repetitions. Three texts of a few
            hundred bytes can test the pipeline, but cannot establish the
            quality of an 8M model.
          </li>
          <li>
            <strong>Compare compatible metrics.</strong> For mean cross-entropy
            in nats, perplexity = exp(loss). Do not directly compare perplexity
            across tokenizers; Track uses one UTF-8 byte per token. High
            throughput measures speed, not quality.
          </li>
        </ol>
        <p className="muted">
          One chart provides a clue, not a complete diagnosis. Check the data
          split, configuration, logs, and generated samples. Keep the final test
          separate from hyperparameter selection.
        </p>
      </section>
    </section>
  );
}
