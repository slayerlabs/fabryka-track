import { useState } from "react";
import { RunChart } from "./RunChart";
import { fmt, type Point } from "./RunData";
import { distinctValidation, rollingReduction } from "./lossAnalysis";

export function ValidationProgress({
  points,
  resumeStep,
  resumeTokens,
  range,
  filter,
}: {
  points: Point[];
  resumeStep?: number;
  resumeTokens?: number;
  range: number;
  filter: string;
}) {
  const checks = distinctValidation(points);
  const defaultReference =
    checks
      .filter((p) => resumeStep !== undefined && p.step <= resumeStep)
      .at(-1) || checks[0];
  const [referenceStep, setReferenceStep] = useState(defaultReference?.step);
  const [window, setWindow] = useState(7);
  const reference = checks.find((p) => p.step === referenceStep) || checks[0];
  const relative = reference
    ? checks
        .filter((p) => p.step >= reference.step)
        .map((p) => ({ ...p, value: reference.value - p.value }))
    : [];
  const rate = rollingReduction(checks, window, resumeStep);
  const current = checks.filter(
    (p) => resumeStep === undefined || p.step > resumeStep,
  );
  const tokenChecks = current.filter((p) => Number.isFinite(p.tokens));
  const searchable = (title: string) =>
    !title.toLowerCase().includes(filter.toLowerCase());
  return (
    <>
      <div className="chart" hidden={searchable("Recent improvement")}>
        <h3>Recent improvement</h3>
        <label className="diagnostic-control">
          Reference evaluation
          <select
            aria-label="Reference evaluation"
            value={reference?.step ?? ""}
            onChange={(e) => setReferenceStep(Number(e.target.value))}
          >
            {checks.map((p) => (
              <option key={p.step} value={p.step}>
                Step {fmt(p.step)}
                {p.tokens !== undefined
                  ? ` · ${fmt(p.tokens / 1e9)}B tokens`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="diagnostic-note">
          Positive values mean lower validation loss than the reference
          evaluation.
        </p>
        <RunChart
          series={[
            {
              name: "Validation loss reduction",
              points: relative,
              smoothing: "off",
            },
          ]}
          zeroLine
          ylabel="Validation loss reduction"
          precision={6}
          range={range}
          resumeStep={resumeStep}
          resumeTokens={resumeTokens}
        />
      </div>
      <div className="chart" hidden={searchable("Learning speed")}>
        <h3>Learning speed</h3>
        <label className="diagnostic-control">
          Regression window
          <select
            aria-label="Regression window"
            value={window}
            onChange={(e) => setWindow(Number(e.target.value))}
          >
            {[3, 5, 7, 9].map((n) => (
              <option key={n} value={n}>
                {n} evaluations
              </option>
            ))}
          </select>
        </label>
        <p className="diagnostic-note">
          Validation loss reduction per billion tokens. Positive means
          improvement.
        </p>
        {tokenChecks.length < window && (
          <p className="diagnostic-note" role="status">
            {resumeStep !== undefined ? "Continuation" : "This run"}:{" "}
            {tokenChecks.length} distinct evaluations with token counts; need{" "}
            {window}. Earlier phases remain visible.
          </p>
        )}
        <RunChart
          series={[
            {
              name: "Loss reduction / billion tokens",
              color: "#477f72",
              points: rate,
              kind: "trend",
              smoothing: "off",
            },
          ]}
          zeroLine
          ylabel="Loss reduction / 1B tokens"
          precision={6}
          range={range}
          resumeStep={resumeStep}
          resumeTokens={resumeTokens}
        />
      </div>
    </>
  );
}
