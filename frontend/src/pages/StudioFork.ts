import { totalShares, validShare } from "./StudioMixData";
import type { Run } from "./RunData";

export interface StudioCheckpoint {
  id: string;
  step: number;
  val_loss: number | null;
  is_best: boolean;
  created_at: string;
  artifact_id: string | null;
}

export interface StudioArchitecture {
  context_length: number;
  layers: number;
  width: number;
  heads: number;
}

export interface StudioForkSettings {
  weights: Record<string, number>;
  name: string;
  model_size: string;
  compute: string;
  steps: number;
  batch_size: number;
  learning_rate: number;
  lr_schedule: string;
  seed: number;
  budget_mode: string;
  target_tokens: number;
  max_runtime_seconds: number;
  early_stopping: boolean;
  patience: number;
  min_delta: number;
  auto_benchmark: boolean;
  auto_benchmark_suite: string;
}

export function hydrateFork(
  parent: Run,
  checkpoint: StudioCheckpoint,
  models: Record<string, { architecture: StudioArchitecture }>,
): StudioForkSettings {
  if (parent.read_only || parent.metadata.engine !== "tiny-transformer")
    throw new Error(
      "Only your own Training studio runs can be forked here. External model checkpoints are not compatible with this trainer.",
    );
  if (
    !checkpoint.artifact_id ||
    !parent.artifacts?.some(
      (artifact) => artifact.id === checkpoint.artifact_id,
    )
  )
    throw new Error(
      "This checkpoint has no accessible model artifact. Choose another saved checkpoint from the parent run.",
    );
  const config = parent.config;
  function number(key: string, fallback: number) {
    const value = config[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`The parent has an unsupported ${key} value.`);
    return value;
  }
  function choice(key: string, options: string[], fallback: string) {
    const value = config[key] ?? fallback;
    if (typeof value !== "string" || !options.includes(value))
      throw new Error(`The parent has an unsupported ${key} value.`);
    return value;
  }
  function boolean(key: string, fallback: boolean) {
    const value = config[key] ?? fallback;
    if (typeof value !== "boolean")
      throw new Error(`The parent has an unsupported ${key} value.`);
    return value;
  }
  const model_size = choice(
    "model_size",
    ["tiny", "small", "8m", "16m", "32m", "64m", "128m", "150m"],
    "tiny",
  );
  const compute = choice("compute", ["cpu", "runpod"], "cpu");
  if ((compute === "cpu") !== ["tiny", "small"].includes(model_size))
    throw new Error(
      "The parent model and compute combination is not supported. CPU and GPU model shapes cannot be interchanged when loading a checkpoint.",
    );
  const architecture =
    model_size === "tiny"
      ? { context_length: 32, layers: 2, width: 64, heads: 4 }
      : model_size === "small"
        ? { context_length: 64, layers: 3, width: 96, heads: 4 }
        : models[model_size]?.architecture;
  if (
    !architecture ||
    Object.entries(architecture).some(([key, value]) => config[key] !== value)
  )
    throw new Error(
      "The checkpoint architecture does not match a supported model preset. Its shape cannot be changed in Training studio.",
    );
  if (
    !Array.isArray(config.mix) ||
    config.mix.length === 0 ||
    config.mix.length > 20
  )
    throw new Error(
      "The parent has no supported dataset mix. Open the original run to inspect its recipe.",
    );
  const weights: Record<string, number> = {};
  for (const item of config.mix) {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      !("weight" in item) ||
      typeof item.id !== "string" ||
      typeof item.weight !== "number" ||
      !validShare(item.weight) ||
      item.id in weights
    )
      throw new Error(
        "The parent dataset mix cannot be restored exactly. Open the original run to inspect its recipe.",
      );
    weights[item.id] = item.weight;
  }
  if (totalShares(Object.values(weights)) !== 100)
    throw new Error(
      "The parent dataset percentages do not add up to 100. Its recipe cannot be restored safely.",
    );
  return {
    weights,
    name: `${parent.name.slice(0, 113)} — fork`,
    model_size,
    compute,
    steps: number("steps", 100),
    batch_size: number("batch_size", 8),
    learning_rate: number("learning_rate", 0.003),
    lr_schedule: choice("lr_schedule", ["constant", "trapezoidal"], "constant"),
    seed: number("seed", 42),
    budget_mode: choice(
      "budget_mode",
      ["manual", "chinchilla", "tokens"],
      "manual",
    ),
    target_tokens: number("target_tokens", 100000000),
    max_runtime_seconds: number("max_runtime_seconds", 3600),
    early_stopping: boolean("early_stopping", true),
    patience: number("patience", 20),
    min_delta: number("min_delta", 0.01),
    auto_benchmark: boolean("auto_benchmark", false),
    auto_benchmark_suite: choice(
      "auto_benchmark_suite",
      ["piqa", "core", "polish", "fast_pl"],
      "piqa",
    ),
  };
}

export interface StudioForkSource {
  parent: Run;
  checkpoint: StudioCheckpoint;
  settings: StudioForkSettings;
}
