import type {
  CheckpointEvaluation,
  DashboardCheckpoint,
  DashboardRun,
} from "./DashboardData";
import { fmt } from "./RunData";

export const activeFamilyRun = (run: DashboardRun) =>
  ["queued", "running", "stopping"].includes(run.state);

export function fullScore(
  evaluation: CheckpointEvaluation,
): evaluation is CheckpointEvaluation & { byte_perplexity: number } {
  return (
    evaluation.status === "finished" &&
    evaluation.mode === "full" &&
    !!evaluation.protocol &&
    !!evaluation.checkpoint_sha256 &&
    typeof evaluation.byte_perplexity === "number" &&
    Number.isFinite(evaluation.byte_perplexity) &&
    evaluation.byte_perplexity > 0 &&
    (evaluation.num_bytes ?? 0) > 0 &&
    (evaluation.num_documents ?? 0) > 0
  );
}

export function validationBests(checkpoints: DashboardCheckpoint[]) {
  const best = new Map<
    string,
    {
      checkpoint: DashboardCheckpoint;
      evaluation: CheckpointEvaluation & { byte_perplexity: number };
    }
  >();
  for (const checkpoint of checkpoints) {
    for (const evaluation of checkpoint.evaluations) {
      if (evaluation.split !== "validation" || !fullScore(evaluation)) continue;
      const previous = best.get(evaluation.protocol);
      if (
        !previous ||
        evaluation.byte_perplexity < previous.evaluation.byte_perplexity
      )
        best.set(evaluation.protocol, { checkpoint, evaluation });
    }
  }
  return [...best.values()];
}

// Compare user-controlled settings, not launch identity, resolved architecture or
// derived budget/throughput estimates. Unknown imported settings remain visible.
const derivedSettings: Record<string, true> = {
  name: true,
  project: true,
  experiment: true,
  parent_run_id: true,
  checkpoint_id: true,
  forked_from_checkpoint_id: true,
  parent_checkpoint_id: true,
  resume_from: true,
  checkpoint_path: true,
  warm_start_checkpoint: true,
  output_dir: true,
  run_id: true,
  model: true,
  planned_training_tokens: true,
  tokens_per_step: true,
  parameter_count: true,
  num_parameters: true,
  params: true,
  estimated_cost: true,
  estimated_cost_usd: true,
  estimated_runtime_seconds: true,
  tokenizer_vocab_size: true,
  vocab_size: true,
  n_params: true,
  n_layers: true,
  n_heads: true,
  d_model: true,
  d_ff: true,
  device: true,
  engine: true,
};
function stableSetting(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSetting).join(", ")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}: ${stableSetting(item)}`)
      .join(", ")}}`;
  return value === undefined ? "not set" : JSON.stringify(value);
}
export function ChangedSettings({
  run,
  parent,
}: {
  run: DashboardRun;
  parent?: DashboardRun;
}) {
  if (!run.parent_run_id)
    return (
      <span className="runs-parent-note">Baseline · saved configuration</span>
    );
  if (!parent)
    return (
      <span className="runs-parent-note">Parent configuration unavailable</span>
    );
  const keys = [
    ...new Set([...Object.keys(parent.config), ...Object.keys(run.config)]),
  ].sort();
  const changes = keys.filter(
    (key) =>
      !Object.hasOwn(derivedSettings, key) &&
      !/^(estimated_|resolved_)/.test(key) &&
      stableSetting(parent.config[key]) !== stableSetting(run.config[key]),
  );
  if (!changes.length)
    return (
      <span className="runs-parent-note">
        No recorded training-setting changes
      </span>
    );
  return (
    <details className="focus-config">
      <summary>
        {changes.length} changed setting{changes.length === 1 ? "" : "s"} vs
        parent
      </summary>
      <dl>
        {changes.map((key) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <del>{stableSetting(parent.config[key])}</del> →{" "}
              {stableSetting(run.config[key])}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function RunMonitoring({ run }: { run: DashboardRun }) {
  const progress =
    typeof run.progress === "number" && Number.isFinite(run.progress)
      ? run.progress
      : null;
  const cost = run.gpu_status?.cost;
  return (
    <div className="focus-monitoring">
      <span>
        Step {fmt(run.step, 0)}
        {progress !== null ? ` · ${fmt(progress * 100, 1)}%` : ""}
      </span>
      {progress !== null && (
        <progress
          max={1}
          value={Math.max(0, Math.min(1, progress))}
          aria-label={`${run.name} training progress`}
        />
      )}
      <span>
        {fmt(run.tokens_seen, 0)} tokens · {fmt(run.throughput, 0)} tokens/s
      </span>
      {run.gpu_status?.phase && (
        <span>
          GPU: {run.gpu_status.phase}
          {run.gpu_status.queue_position
            ? ` · queue #${run.gpu_status.queue_position}`
            : ""}
        </span>
      )}
      {typeof cost?.billed_usd === "number" ? (
        <span>${fmt(cost.billed_usd, 2)} billed</span>
      ) : typeof cost?.estimated_usd === "number" ? (
        <span>
          ~${fmt(cost.estimated_usd, 2)} estimated
          {cost.complete === false ? " · partial" : ""}
        </span>
      ) : null}
      {run.gpu_status?.error && (
        <span className="error">{run.gpu_status.error}</span>
      )}
    </div>
  );
}
