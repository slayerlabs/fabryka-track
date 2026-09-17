import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { Link, useNavigate, useSearchParams } from "react-router";
import { request } from "../provider";
import { LoginPage, type StudioUser } from "./Account";
import { StudioMixRecipes } from "./StudioMixRecipes";
import { normalizeShares, roundShare, totalShares, type RecipeSource } from "./StudioMixData";
import { corpusSources } from "./StudioData";
import { StudioHFDatasets } from "./StudioHFDatasets";
import { StudioDatasetReader, type Dataset } from "./StudioDatasetReader";
import { useRunQuery, type Run } from "./RunData";
import { useDashboard } from "./DashboardData";
import {
  hydrateFork,
  type StudioArchitecture,
  type StudioCheckpoint,
  type StudioForkSource,
} from "./StudioFork";
export { GuidePage } from "./StudioGuide";

interface Capabilities {
  runpod_available: boolean;
  gpu: string;
  max_seconds: number;
  max_hourly_usd: number;
  models: Record<
    string,
    {
      parameters: number;
      label: string;
      architecture: StudioArchitecture;
    }
  >;
}
interface Draft {
  weights: Record<string, number>;
  name: string;
  steps: number;
  batch_size: number;
  learning_rate: number;
  seed: number;
  model_size: string;
  budget_mode: string;
  target_tokens: number;
  compute: string;
  max_runtime_seconds: number;
  lr_schedule: string;
  early_stopping: boolean;
  patience: number;
  min_delta: number;
  auto_benchmark: boolean;
  auto_benchmark_suite: string;
  auto_benchmark_suite_version: number;
  character: string | null;
  training_budget_version: number;
  point_budget_version: number;
  precise_weights: boolean;
}
const initialDraft: Draft = {
  weights: {},
  name: "New training run",
  steps: 100,
  batch_size: 8,
  learning_rate: 0.003,
  seed: 42,
  model_size: "tiny",
  budget_mode: "chinchilla",
  target_tokens: 100000000,
  compute: "",
  max_runtime_seconds: 3600,
  lr_schedule: "constant",
  early_stopping: true,
  patience: 20,
  min_delta: 0.01,
  auto_benchmark: true,
  auto_benchmark_suite: "tiny_ml",
  auto_benchmark_suite_version: 1,
  character: null,
  training_budget_version: 1,
  point_budget_version: 1,
  precise_weights: false,
};
const profiles = [
  { id: "poet", name: "Poet / writer", category: "literature" },
  { id: "lawyer", name: "Lawyer / civil servant", category: "law" },
  { id: "wiki", name: "Wikipedia reader", category: "encyclopedia" },
  { id: "scientist", name: "Scientist", category: "science" },
  { id: "internet", name: "Internet person", category: "web" },
  { id: "balanced", name: "Balanced (corpus-like)", category: "" },
];
const categories: Record<string, string> = {
  literature: "Literature",
  law: "Law / administration",
  encyclopedia: "Encyclopedia",
  science: "Science",
  web: "Internet",
  code: "Code",
  other: "Other / uncategorized",
};
const exampleCategories: Record<string, string> = {
  "Polish prose": "literature",
  "Everyday English": "literature",
  "Python snippets": "code",
};
const colors = ["#a84d33", "#527660", "#647d96", "#b49953", "#967c98"];
const fmt = (n: number, digits = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";
const datasetColor = (dataset: Dataset) =>
  corpusSources[dataset.id]?.color ||
  colors[
    parseInt(dataset.id.replaceAll("-", "").slice(0, 6), 16) % colors.length
  ] ||
  colors[0];

function allocatePoints(
  items: { id: string; size: number }[],
  totalPoints = 20,
) {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const allocations = items.map((item) => {
    const exact = total > 0 ? (totalPoints * item.size) / total : 0;
    return { id: item.id, value: Math.floor(exact), remainder: exact % 1 };
  });
  let remaining =
    total > 0
      ? totalPoints - allocations.reduce((sum, item) => sum + item.value, 0)
      : 0;
  [...allocations]
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((item) => {
      if (remaining > 0) {
        item.value++;
        remaining--;
      }
    });
  return Object.fromEntries(
    allocations.map((item) => [item.id, item.value * 5]),
  );
}

function restoreDraft(
  userId: string,
  datasets: Dataset[],
  capabilities: Capabilities,
): Draft {
  const draft = structuredClone(initialDraft);
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`training-draft-v3:${userId}`) || "{}",
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      saved = Object.fromEntries(Object.entries(parsed));
  } catch {
    /* Storage may be unavailable or contain a malformed draft. */
  }
  for (const key of [
    "name",
    "model_size",
    "budget_mode",
    "compute",
    "lr_schedule",
    "auto_benchmark_suite",
  ] as const)
    if (typeof saved[key] === "string") draft[key] = saved[key];
  for (const key of [
    "steps",
    "batch_size",
    "learning_rate",
    "seed",
    "target_tokens",
    "max_runtime_seconds",
    "patience",
    "min_delta",
  ] as const)
    if (typeof saved[key] === "number" && Number.isFinite(saved[key]))
      draft[key] = saved[key];
  for (const key of ["early_stopping", "auto_benchmark"] as const)
    if (typeof saved[key] === "boolean") draft[key] = saved[key];
  draft.precise_weights = saved.precise_weights === true;
  draft.character =
    typeof saved.character === "string" ? saved.character : null;
  if (
    saved.weights &&
    typeof saved.weights === "object" &&
    !Array.isArray(saved.weights)
  )
    draft.weights = Object.fromEntries(
      Object.entries(saved.weights).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  if (saved.training_budget_version !== 1) draft.budget_mode = "chinchilla";
  if (saved.auto_benchmark_suite_version !== 1 && draft.auto_benchmark_suite === "piqa")
    draft.auto_benchmark_suite = "tiny_ml";
  if (!draft.name.trim()) draft.name = initialDraft.name;
  if (!draft.compute) {
    draft.compute = capabilities.runpod_available ? "runpod" : "cpu";
    if (draft.compute === "runpod") {
      draft.model_size = "8m";
      draft.learning_rate = 0.0003;
      draft.budget_mode = "chinchilla";
    }
  }
  if (draft.compute === "runpod" && !capabilities.runpod_available) {
    draft.compute = "cpu";
    draft.model_size = "tiny";
  }
  if (draft.compute !== "runpod")
    draft.model_size = draft.model_size === "small" ? "small" : "tiny";
  else if (!capabilities.models[draft.model_size]) draft.model_size = "8m";
  draft.max_runtime_seconds = Math.min(
    draft.max_runtime_seconds || 3600,
    capabilities.max_seconds || 3600,
  );
  const weights = Object.fromEntries(
    datasets.map((dataset) => [
      dataset.id,
      Math.max(
        0,
        Math.min(
          100,
          draft.weights[dataset.id] ??
            (corpusSources[dataset.id]?.previous_ids || []).reduce(
              (sum, id) => sum + (draft.weights[id] || 0),
              0,
            ),
        ),
      ),
    ]),
  );
  draft.weights =
    saved.point_budget_version !== 1 ||
    (!draft.precise_weights && Object.values(weights).some((weight) => weight % 5 !== 0)) ||
    (!draft.precise_weights && totalShares(Object.values(weights)) > 100)
      ? allocatePoints(
          datasets.map((dataset) => ({
            id: dataset.id,
            size: weights[dataset.id],
          })),
        )
      : Object.fromEntries(Object.entries(weights).map(([id, weight]) => [id, roundShare(weight)]));
  return draft;
}

export function StudioPage() {
  const [params] = useSearchParams();
  const parentId = params.get("parent");
  const checkpointId = params.get("checkpoint");
  const { query } = useCustom<{ user: StudioUser | null }>({
    url: "/api/auth/me",
    method: "get",
  });
  if (query.isLoading) return <p role="status">Loading your workspace…</p>;
  if (query.error)
    return (
      <p className="error" role="alert">
        {query.error.message}
      </p>
    );
  const user = query.data?.data.user;
  return user ? (
    <StudioLoader
      key={`${user.id}:${parentId || ""}:${checkpointId || ""}`}
      user={user}
      parentId={parentId}
      checkpointId={checkpointId}
    />
  ) : (
    <LoginPage />
  );
}

function StudioLoader({
  user,
  parentId,
  checkpointId,
}: {
  user: StudioUser;
  parentId: string | null;
  checkpointId: string | null;
}) {
  const library = useCustom<Dataset[]>({
    url: "/api/datasets",
    method: "get",
    queryOptions: { queryKey: ["studio-datasets", user.id] },
  });
  const capabilities = useCustom<Capabilities>({
    url: "/api/training/capabilities",
    method: "get",
    queryOptions: { queryKey: ["studio-capabilities", user.id] },
  });
  const datasets = useMemo(() => {
    const items = library.query.data?.data || [];
    return items.some((dataset) => corpusSources[dataset.id])
      ? items.filter((dataset) => !dataset.example || corpusSources[dataset.id])
      : items;
  }, [library.query.data]);
  const refresh = useCallback(() => {
    void library.query.refetch();
  }, [library.query.refetch]);
  const failure = library.query.error || capabilities.query.error;
  if (failure)
    return (
      <p className="error" role="alert">
        {failure.message}
      </p>
    );
  if (!library.query.data || !capabilities.query.data)
    return <p role="status">Loading datasets and compute options…</p>;
  if (parentId !== null || checkpointId !== null) {
    if (!parentId || !checkpointId)
      return (
        <p className="error" role="alert">
          Select both a parent run and a saved checkpoint.{" "}
          <Link to="/checkpoints">Choose a checkpoint</Link>.
        </p>
      );
    return (
      <StudioForkLoader
        user={user}
        parentId={parentId}
        checkpointId={checkpointId}
        datasets={library.query.data.data}
        capabilities={capabilities.query.data.data}
        onRefresh={refresh}
      />
    );
  }
  return (
    <TrainingStudio
      user={user}
      datasets={datasets}
      capabilities={capabilities.query.data.data}
      onRefresh={refresh}
    />
  );
}

function StudioForkLoader({
  user,
  parentId,
  checkpointId,
  datasets,
  capabilities,
  onRefresh,
}: {
  user: StudioUser;
  parentId: string;
  checkpointId: string;
  datasets: Dataset[];
  capabilities: Capabilities;
  onRefresh: () => void;
}) {
  const parent = useRunQuery<Run>(`/api/runs/${encodeURIComponent(parentId)}`);
  const checkpoints = useRunQuery<StudioCheckpoint[]>(
    `/api/runs/${encodeURIComponent(parentId)}/checkpoints`,
  );
  const dashboard = useDashboard();
  const failure = parent.error || checkpoints.error || dashboard.error;
  if (failure)
    return (
      <p className="error" role="alert">
        Cannot load this fork: {failure.message}{" "}
        <Link to="/checkpoints">Choose an accessible checkpoint</Link>.
      </p>
    );
  if (!parent.data || !checkpoints.data || !dashboard.data)
    return <p role="status">Loading parent recipe and checkpoint…</p>;
  let source: StudioForkSource;
  try {
    const checkpoint = checkpoints.data.find(
      (item) => item.id === checkpointId,
    );
    const owned = dashboard.data.checkpoints.find(
      (item) => item.id === checkpointId && item.run_id === parentId,
    );
    if (!checkpoint || !owned)
      throw new Error(
        "This checkpoint does not belong to an accessible parent run.",
      );
    if (!owned.can_fork)
      throw new Error(
        "This checkpoint cannot be loaded by the trainer. Choose a supported checkpoint whose model artifact is still available on the server.",
      );
    source = {
      parent: parent.data,
      checkpoint,
      settings: hydrateFork(parent.data, checkpoint, capabilities.models),
    };
    const missing = Object.keys(source.settings.weights).filter(
      (id) => !datasets.some((dataset) => dataset.id === id),
    );
    if (missing.length)
      throw new Error(
        `The parent uses datasets that are missing or inaccessible (${missing.join(", ")}). Restore access to those original datasets, then refresh. No replacement data has been selected.`,
      );
    if (source.settings.compute === "runpod" && !capabilities.runpod_available)
      throw new Error(
        "This checkpoint requires RunPod GPU access, which is not enabled for your account. Enable GPU access before forking; switching to a CPU model would be incompatible.",
      );
  } catch (error) {
    return (
      <div className="notice" role="alert">
        <p>
          {error instanceof Error
            ? error.message
            : "Cannot restore this checkpoint."}
        </p>
        <button className="secondary" onClick={onRefresh}>
          Refresh datasets
        </button>{" "}
        <Link to={`/run/${encodeURIComponent(parentId)}`}>Open parent run</Link>
        {" · "}
        <Link to="/checkpoints">Choose another checkpoint</Link>
      </div>
    );
  }
  return (
    <TrainingStudio
      user={user}
      datasets={datasets}
      capabilities={capabilities}
      onRefresh={onRefresh}
      fork={source}
    />
  );
}

function TrainingStudio({
  user,
  datasets,
  capabilities,
  onRefresh,
  fork,
}: {
  user: StudioUser;
  datasets: Dataset[];
  capabilities: Capabilities;
  onRefresh: () => void;
  fork?: StudioForkSource;
}) {
  const [draft, setDraft] = useState(() =>
    fork
      ? { ...initialDraft, ...fork.settings }
      : restoreDraft(user.id, datasets, capabilities),
  );
  const [recipeRequest, setRecipeRequest] = useState<{ source: RecipeSource; nonce: number }>();
  const [stage, setStage] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [preview, setPreview] = useState<Dataset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const setup = useRef<HTMLFormElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const { mutateAsync } = useCustomMutation<{ id: string }>();
  useEffect(() => {
    if (fork) return;
    try {
      localStorage.setItem(
        `training-draft-v3:${user.id}`,
        JSON.stringify(draft),
      );
    } catch {
      /* Keep the current draft usable when storage is unavailable. */
    }
  }, [draft, user.id, fork]);
  useEffect(() => () => controller.current?.abort(), []);
  const mix = datasets
    .filter((dataset) => (draft.weights[dataset.id] || 0) > 0)
    .map((dataset) => ({ ...dataset, weight: draft.weights[dataset.id] }));
  const totalWeight = totalShares(mix.map((dataset) => dataset.weight));
  const precise = Boolean(fork) || draft.precise_weights;
  const points = totalWeight / 5;
  const launchIssue =
    mix.length > 20
      ? "Use no more than 20 datasets."
      : Object.entries(draft.weights).some(
            ([id, weight]) =>
              weight > 0 && !datasets.some((dataset) => dataset.id === id),
          )
        ? "A selected dataset is no longer available. Restore access and refresh before launching."
        : draft.compute === "runpod" &&
            draft.max_runtime_seconds > capabilities.max_seconds
          ? "Reduce the GPU time limit to the current server maximum."
          : draft.compute === "cpu" &&
              mix.reduce((sum, dataset) => sum + dataset.bytes, 0) > 100000000
            ? "CPU training supports at most 100 MB of source data. Choose a smaller mix."
            : "";
  const gpu = draft.compute === "runpod";
  const model = gpu ? capabilities.models[draft.model_size] : undefined;
  const parameters =
    model?.parameters || (draft.model_size === "small" ? 391008 : 134912);
  const context =
    model?.architecture.context_length ||
    (draft.model_size === "small" ? 64 : 32);
  const length = Math.max(
    1,
    Math.min(
      context,
      ...mix.map((dataset) => Math.floor(dataset.bytes * 0.9) - 1),
    ),
  );
  const steps =
    draft.budget_mode === "chinchilla"
      ? Math.ceil((parameters * 20) / (draft.batch_size * length))
      : draft.budget_mode === "tokens"
        ? Math.ceil(draft.target_tokens / (draft.batch_size * length))
        : draft.steps;
  const tokens = steps * draft.batch_size * length;
  const available = mix.reduce(
    (sum, dataset) => sum + Math.floor(dataset.bytes * 0.9),
    0,
  );
  const reuse = Math.max(
    0,
    ...mix.map(
      (dataset) =>
        (tokens * dataset.weight) / 100 / Math.floor(dataset.bytes * 0.9),
    ),
  );
  const modelName = `${gpu ? draft.model_size.toUpperCase() : draft.model_size === "small" ? "Small" : "Tiny"} transformer`;
  const computeName = gpu ? "RunPod GPU" : "Local CPU";
  const scaleTokens =
    gpu && draft.budget_mode === "chinchilla"
      ? parameters * 20
      : draft.target_tokens;
  const scaleParameters = gpu ? parameters : scaleTokens / 20;
  const books = mix.flatMap((dataset) =>
    Array.from({ length: dataset.weight / 5 }, () => dataset),
  );
  function update(patch: Partial<Draft>) {
    setDraft((previous) => ({
      ...previous,
      ...patch,
      ...(fork
        ? {
            model_size: fork.settings.model_size,
            compute: fork.settings.compute,
          }
        : {}),
    }));
  }
  function balance(id: string, value: number) {
    if (!Number.isFinite(value)) return;
    setDraft((previous) => {
      const others = totalShares(datasets.filter((d) => d.id !== id).map((d) => previous.weights[d.id] || 0));
      const requested = precise ? roundShare(value) : Math.round(value / 5) * 5;
      return { ...previous, character: null, weights: {
        ...previous.weights, [id]: roundShare(Math.max(0, Math.min(requested, precise ? 100 : 100 - others))),
      } };
    });
    setProfileMessage("");
  }
  function applyProfile(profile: (typeof profiles)[number]) {
    const selected = datasets.filter(
      (dataset) =>
        !profile.category ||
        (corpusSources[dataset.id]?.category ||
          dataset.category ||
          (dataset.example ? exampleCategories[dataset.name] : "") ||
          "other") === profile.category,
    );
    if (!selected.length) {
      setProfileMessage(
        `No sources are available for the “${categories[profile.category]}” category. This profile needs a matching corpus. The current mix was left unchanged.`,
      );
      return;
    }
    update({
      character: profile.id,
      precise_weights: false,
      weights: allocatePoints(
        selected.map((dataset) => ({ id: dataset.id, size: dataset.bytes })),
      ),
    });
    setProfileMessage("");
  }
  function moveTo(next: number) {
    if (stage === 2 && !setup.current?.reportValidity()) return;
    if (next > 1 && totalWeight !== 100) return;
    if (next === 3 && launchIssue) return;
    if (stage === 2) update({ name: draft.name.trim() });
    setStage(next);
    setError("");
  }
  async function uploadFile(file: File) {
    setUploading(true);
    setError("");
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    try {
      if (file.size > 2000000)
        throw new Error(
          "Use a text file smaller than 2 MB for local training.",
        );
      const body = new FormData();
      body.append("file", file);
      await request<Dataset>("/api/datasets", {
        method: "POST",
        body,
        signal: abort.signal,
      });
      if (!abort.signal.aborted) {
        update({ character: null });
        onRefresh();
        setMessage("Text added. Adjust its slider to include it.");
      }
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not upload text.");
    } finally {
      if (!abort.signal.aborted) {
        setUploading(false);
        if (upload.current) upload.current.value = "";
      }
    }
  }
  async function launch() {
    if (stage !== 3 || totalWeight !== 100 || launchIssue || launching) return;
    setLaunching(true);
    setError("");
    try {
      const response = await mutateAsync({
        url: "/api/training",
        method: "post",
        values: {
          name: draft.name,
          steps: draft.budget_mode !== "manual" ? 100 : draft.steps,
          budget_mode: draft.budget_mode,
          early_stopping: draft.early_stopping,
          patience: draft.patience,
          min_delta: draft.min_delta,
          batch_size: draft.batch_size,
          learning_rate: draft.learning_rate,
          lr_schedule: draft.lr_schedule,
          auto_benchmark: draft.auto_benchmark,
          auto_benchmark_suite: draft.auto_benchmark_suite,
          seed: draft.seed,
          model_size: draft.model_size,
          compute: draft.compute,
          target_tokens: draft.target_tokens,
          max_runtime_seconds: draft.max_runtime_seconds,
          ...(fork
            ? {
                parent_run_id: fork.parent.id,
                checkpoint_id: fork.checkpoint.id,
              }
            : {}),
          mix: mix.map((dataset) => ({
            dataset_id: dataset.id,
            weight: dataset.weight,
          })),
        },
      });
      navigate(`/run/${response.data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start training.");
      setLaunching(false);
    }
  }
  const warning = (
    <div className="notice">
      {!mix.length ? (
        <>
          Choose a profile or assign points to build a mix. Available library:{" "}
          {datasets.length} sources,{" "}
          {fmt(
            datasets.reduce((sum, dataset) => sum + dataset.bytes, 0) / 1e6,
            1,
          )}{" "}
          MB of actual text.
        </>
      ) : (
        <>
          {available < 10000 &&
            "Very little training text: this run is a workflow test. Upload more varied text before increasing the model or budget. "}
          {reuse > 4 &&
            `At the step limit, the most reused source would be sampled approximately ${fmt(reuse, 1)} times its training size. These are repeated byte tokens, not fresh data. `}
          Validation checks a fixed sample of held-out text to help select the
          saved model. Its score is a diagnostic for this mix, not an
          independent final test. <Link to="/guide">What is validation?</Link>
        </>
      )}
    </div>
  );
  return (
    <>
      <div className="intro studio-intro">
        <div className="eyebrow">Training studio</div>
        <h1>
          {fork
            ? "Fork from a saved checkpoint."
            : "A model starts with a mix."}
        </h1>
        <p className="muted">
          {fork
            ? "Review the inherited recipe, adjust your next experiment, and explicitly launch when ready. Nothing starts automatically."
            : "Choose your data, train a model, and follow its progress live."}
        </p>
      </div>
      {fork && (
        <div className="notice">
          <b>Source checkpoint</b>
          {" · "}
          <Link to={`/run/${encodeURIComponent(fork.parent.id)}`}>
            {fork.parent.name}
          </Link>
          <p>
            Step {fmt(fork.checkpoint.step, 0)} · validation loss{" "}
            {fork.checkpoint.val_loss === null
              ? "—"
              : fmt(fork.checkpoint.val_loss, 4)}{" "}
            · {fork.checkpoint.is_best ? "best checkpoint" : "saved checkpoint"}
          </p>
          <small>
            {fork.checkpoint.id} · Model shape and compute are locked for
            compatibility. Model weights are inherited; optimizer, schedule, and
            step counter start fresh.
          </small>
        </div>
      )}
      {launchIssue && (
        <p className="error" role="alert">
          {launchIssue}
        </p>
      )}
      <div className="steps studio-steps" aria-label="Training setup">
        {["Mix datasets", "Set up training", "Review & start"].map(
          (label, index) => (
            <button
              key={label}
              className={`step ${stage === index + 1 ? "active" : ""}`}
              disabled={index + 1 > stage || launching}
              onClick={() => moveTo(index + 1)}
            >
              <b>{index + 1}</b>
              {label}
            </button>
          ),
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="layout">
        <section className="panel" id="workspace">
          {stage === 1 ? (
            <>
              <StudioMixRecipes
                datasets={datasets}
                onImport={(source) => setRecipeRequest({ source, nonce: Date.now() })}
                onApply={(weights) => {
                  update({ weights, precise_weights: true, character: null });
                  setMessage("Ivme v3 shares applied exactly. Review your model and budget before starting.");
                }}
                onImported={() => {
                  update({ character: null });
                  onRefresh();
                }}
              />
              {precise ? (
                <div className="notice">
                  <b>{fork ? "Inherited dataset mix" : "Exact dataset shares"}</b>
                  <p>
                    Dataset percentages are preserved exactly.
                    Adjust shares to two decimal places; the total must remain 100%.
                  </p>
                  <p role="status" aria-live="polite">{totalWeight > 100 ? `${roundShare(totalWeight - 100)}% over allocated` : `${roundShare(100 - totalWeight)}% remaining`}</p>
                  <button type="button" className="secondary" disabled={!mix.length || totalWeight === 100} onClick={() => update({ weights: normalizeShares(Object.fromEntries(mix.map((d) => [d.id, d.weight]))), character: null })}>Normalize to 100%</button>{" "}
                  <button type="button" className="preview-link" onClick={() => update({ weights: {}, character: null })}>Clear shares</button>
                </div>
              ) : (
                <section
                  className="character"
                  aria-labelledby="character-title"
                >
                  <div className="eyebrow">Character development</div>
                  <h2 id="character-title">What should this model become?</h2>
                  <p className="muted">
                    Spend exactly 20 character development points to shape the
                    model’s training profile. Each point assigns 5% of the
                    training mix to a dataset.
                  </p>
                  <div
                    className="character-buttons"
                    role="group"
                    aria-label="Character development profile"
                  >
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        aria-pressed={draft.character === profile.id}
                        onClick={() => applyProfile(profile)}
                      >
                        {profile.name}
                      </button>
                    ))}
                  </div>
                  <div className="row" style={{ margin: "16px 0" }}>
                    <b role="status" aria-live="polite">
                      {20 - points} character development points remaining
                    </b>
                    <button
                      className="secondary"
                      onClick={() => {
                        update({ weights: {}, character: null });
                        setProfileMessage("");
                      }}
                    >
                      Reset points
                    </button>
                  </div>
                  <div
                    className="point-shelf"
                    role="group"
                    aria-label="20 character development points"
                  >
                    {Array.from({ length: 20 }, (_, index) => {
                      const book = books[index];
                      return (
                        <span
                          key={index}
                          className={`point-book${book ? "" : " empty"}`}
                          style={
                            book
                              ? ({
                                  "--book-color": datasetColor(book),
                                } as CSSProperties)
                              : undefined
                          }
                          title={
                            book
                              ? `${book.name} · 1 point · 5%`
                              : `Available point ${index + 1}`
                          }
                          role="img"
                          aria-label={
                            book
                              ? `${book.name}: 1 point`
                              : `Available point ${index + 1}`
                          }
                        >
                          {index + 1}
                        </span>
                      );
                    })}
                  </div>
                  <p className="muted" role="status" aria-live="polite">
                    {profileMessage ||
                      (draft.character
                        ? `${profiles.find((profile) => profile.id === draft.character)?.name} · Shares based on available text size (UTF-8 bytes).`
                        : "Choose a profile or set a custom mix with the sliders. 1 book = 1 point = 5% of the mix.")}
                  </p>
                  <small>
                    Profiles distribute points across available real corpus
                    samples. Open any dataset to inspect its text and source.
                    Sizes refer to the downloaded sample, not the full corpus.
                  </small>
                </section>
              )}
              {!precise && <button type="button" className="preview-link" onClick={() => update({ precise_weights: true, character: null })}>Edit exact percentages</button>}
              <h2>Your dataset library</h2>
              {datasets.map((dataset) => {
                const weight = draft.weights[dataset.id] || 0;
                const corpus = corpusSources[dataset.id];
                return (
                  <div
                    className="dataset compact-dataset"
                    data-empty={!weight}
                    key={dataset.id}
                  >
                    <div className="dataset-heading">
                      <div
                        className="dataset-cover"
                        style={
                          {
                            "--book-color": datasetColor(dataset),
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      >
                        <b>{dataset.name.slice(0, 2).toUpperCase()}</b>
                        <small>DATASET</small>
                      </div>
                      <div className="dataset-title">
                        <h3>{dataset.name}</h3>
                        <small>
                          {corpus
                            ? `Corpus sample · ${corpus.documents} documents · ${dataset.bytes >= 1e6 ? `${fmt(dataset.bytes / 1e6, 1)} MB` : `${fmt(dataset.bytes / 1000, 1)} KB`} of text`
                            : `${dataset.example ? "Archived test text" : "Your private file"} · ${fmt(dataset.bytes / 1000, 1)} KB`}
                        </small>
                        <button
                          type="button"
                          className="preview-link"
                          onClick={() => setPreview(dataset)}
                        >
                          Open dataset →
                        </button>
                      </div>
                    </div>
                    <div className="dataset-controls">
                      <button
                        type="button"
                        className="point-control"
                        disabled={!weight}
                        aria-label={`Remove ${precise ? "0.01%" : "a point"}: ${dataset.name}`}
                        onClick={() =>
                          balance(dataset.id, weight - (precise ? 0.01 : 5))
                        }
                      >
                        −
                      </button>
                      <input
                        id={`slider-${dataset.id}`}
                        type={precise ? "number" : "range"}
                        min={0}
                        max={precise ? 100 : 20}
                        step={precise ? 0.01 : 1}
                        value={precise ? weight : weight / 5}
                        aria-label={`${dataset.name} ${precise ? "percentage" : "points"}`}
                        onChange={(event) =>
                          balance(
                            dataset.id,
                            +event.target.value * (precise ? 1 : 5),
                          )
                        }
                        style={{ accentColor: datasetColor(dataset) }}
                      />
                      <button
                        type="button"
                        className="point-control"
                        disabled={precise ? weight >= 100 : points >= 20}
                        aria-label={`Add ${precise ? "0.01%" : "a point"}: ${dataset.name}`}
                        onClick={() =>
                          balance(dataset.id, weight + (precise ? 0.01 : 5))
                        }
                      >
                        +
                      </button>
                      <output
                        className="percent"
                        htmlFor={`slider-${dataset.id}`}
                      >
                        {precise
                          ? `${weight.toFixed(2)}%`
                          : `${weight / 5} points · ${weight}%`}
                      </output>
                    </div>
                  </div>
                );
              })}
              <div className="upload">
                <div>
                  <b>Bring your own data</b>
                  <p className="muted">
                    UTF-8 plain text · 100+ characters · up to 2 MB
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={uploading}
                  onClick={() => upload.current?.click()}
                >
                  {uploading ? "Uploading…" : "+ Add text file"}
                </button>
                <input
                  ref={upload}
                  type="file"
                  accept=".txt,text/plain"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadFile(file);
                  }}
                />
              </div>
              <StudioHFDatasets
                userId={user.id}
                recipeRequest={recipeRequest}
                onImported={() => {
                  update({ character: null });
                  onRefresh();
                }}
              />
              <small>Real corpus samples for training.</small>
            </>
          ) : stage === 2 ? (
            <>
              {warning}
              <h2>Set up your training run.</h2>
              <div className="choice">
                <h3>
                  {modelName} · {computeName}
                </h3>
                <p>
                  {fmt(parameters, 0)} parameters,{" "}
                  {model?.architecture.layers ||
                    (draft.model_size === "small" ? 3 : 2)}{" "}
                  layers, {context}-byte context.{" "}
                  {fork
                    ? "Initialized from the selected checkpoint."
                    : "Initialized from scratch."}
                </p>
              </div>
              <form
                id="setup"
                ref={setup}
                onSubmit={(event) => {
                  event.preventDefault();
                  moveTo(3);
                }}
              >
                <label className="field">
                  <span>Model size</span>
                  <select
                    disabled={Boolean(fork)}
                    value={draft.model_size}
                    onChange={(event) =>
                      update({ model_size: event.target.value })
                    }
                  >
                    {gpu ? (
                      Object.entries(capabilities.models).map(([id, value]) => (
                        <option key={id} value={id}>
                          {value.label}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="tiny">Tiny · 134,912 parameters</option>
                        <option value="small">
                          Small · 391,008 parameters
                        </option>
                      </>
                    )}
                  </select>
                  <small>
                    {fork
                      ? "The model shape is locked to the source checkpoint."
                      : "All models train from scratch on the selected compute. GPU models use a 512-byte context."}
                  </small>
                </label>
                <label className="field">
                  <span>Training budget</span>
                  <select
                    value={draft.budget_mode}
                    onChange={(event) =>
                      update({ budget_mode: event.target.value })
                    }
                  >
                    <option value="chinchilla">
                      Chinchilla upper limit · 20 tokens per parameter
                    </option>
                    <option value="tokens">
                      Custom token budget · {fmt(draft.target_tokens / 1e6, 2)}M
                    </option>
                    <option value="manual">
                      Validation-guided · manual step limit
                    </option>
                  </select>
                  <small>
                    Up to {fmt(tokens, 0)} byte tokens in {fmt(steps, 0)}{" "}
                    updates. Available training text: {fmt(available, 0)} bytes.
                    Most reused source: approximately {fmt(reuse, 1)}× at the
                    step limit. Early stopping can finish sooner.
                  </small>
                </label>
                {draft.budget_mode === "tokens" && (
                  <label className="field">
                    <span>Custom training tokens</span>
                    <input
                      type="number"
                      min={100000}
                      max={10000000000}
                      required
                      value={draft.target_tokens}
                      onChange={(event) =>
                        update({ target_tokens: +event.target.value })
                      }
                    />
                  </label>
                )}
                <div className="notice">
                  Validation is checked periodically during training. Downloaded
                  model.pt contains the checkpoint with the lowest validation
                  loss. Chinchilla is an optional upper limit, not a requirement
                  to keep training. Early stopping is enabled unless you turn it
                  off below.
                </div>
                <label className="field">
                  <span>Run name</span>
                  <input
                    name="name"
                    required
                    minLength={8}
                    maxLength={120}
                    placeholder="e.g. Polish-heavy baseline"
                    value={draft.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                  <small>
                    Use a descriptive name including the model, dataset or
                    experiment.
                  </small>
                </label>
                <div className="fields">
                  <label className="field">
                    <span>Maximum training steps</span>
                    <input
                      type="number"
                      min={10}
                      max={2000}
                      required
                      disabled={draft.budget_mode !== "manual"}
                      value={
                        draft.budget_mode === "manual" ? draft.steps : steps
                      }
                      onChange={(event) =>
                        update({ steps: +event.target.value })
                      }
                    />
                    <small>
                      The step count is an upper limit. Disable early stopping
                      below to run the complete learning-rate schedule.
                    </small>
                  </label>
                  <label className="field">
                    <span>Batch size</span>
                    <select
                      value={draft.batch_size}
                      onChange={(event) =>
                        update({ batch_size: +event.target.value })
                      }
                    >
                      {[...new Set([1, 2, 4, 8, 16, 32, draft.batch_size])]
                        .sort((a, b) => a - b)
                        .map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                    </select>
                    <small>
                      Each sequence uses the selected model’s context, shortened
                      for small datasets.
                    </small>
                  </label>
                </div>
                <details>
                  <summary>Advanced settings</summary>
                  <div className="fields">
                    <label className="field">
                      <span>Learning rate</span>
                      <input
                        type="number"
                        min={0.0001}
                        max={0.1}
                        step="any"
                        required
                        value={draft.learning_rate}
                        onChange={(event) =>
                          update({ learning_rate: +event.target.value })
                        }
                      />
                      <small>How much each update changes the model.</small>
                    </label>
                    <label className="field">
                      <span>Learning-rate schedule</span>
                      <select
                        value={draft.lr_schedule}
                        onChange={(event) =>
                          update({ lr_schedule: event.target.value })
                        }
                      >
                        <option value="constant">Constant</option>
                        <option value="trapezoidal">
                          Trapezoidal · 5% warmup, 50% cooldown
                        </option>
                      </select>
                      <small>
                        Warm up to peak, hold until halfway, then cool linearly
                        to 5% of peak. Early stopping may end the schedule
                        sooner.
                      </small>
                    </label>
                    <label className="field">
                      <span>Random seed</span>
                      <input
                        type="number"
                        min={0}
                        max={4294967295}
                        required
                        value={draft.seed}
                        onChange={(event) =>
                          update({ seed: +event.target.value })
                        }
                      />
                      <small>Use the same seed to repeat an experiment.</small>
                    </label>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.early_stopping}
                      onChange={(event) =>
                        update({ early_stopping: event.target.checked })
                      }
                    />{" "}
                    Early stopping
                  </label>
                  <div className="fields">
                    <label className="field">
                      <span>Early stopping patience</span>
                      <input
                        type="number"
                        min={5}
                        max={100}
                        required
                        value={draft.patience}
                        onChange={(event) =>
                          update({ patience: +event.target.value })
                        }
                      />
                      <small>
                        Validation checks without sufficient improvement.
                      </small>
                    </label>
                    <label className="field">
                      <span>Minimum validation improvement</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step="any"
                        required
                        value={draft.min_delta}
                        onChange={(event) =>
                          update({ min_delta: +event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div style={{ marginTop: 16 }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.auto_benchmark}
                        onChange={(event) =>
                          update({ auto_benchmark: event.target.checked })
                        }
                      />{" "}
                      Run a full benchmark automatically after successful
                      training
                    </label>
                    <label className="field">
                      <span>Background evaluation</span>
                      <select
                        value={draft.auto_benchmark_suite}
                        onChange={(event) =>
                          update({ auto_benchmark_suite: event.target.value })
                        }
                      >
                        <option value="tiny_ml">
                          Tiny-ML · WikiText-2 BYTE_PPL + BLiMP + ARC-Easy + ACI
                        </option>
                        <option value="piqa">
                          PIQA · English physical commonsense
                        </option>
                        <option value="core">
                          Core · 5 English tasks including PIQA
                        </option>
                        <option value="polish">
                          MultiBLiMP · Polish agreement
                        </option>
                        <option value="fast_pl">
                          Polish ladder · BPB + agreement + induction
                        </option>
                      </select>
                      <small>
                        Runs on the background benchmark worker after the
                        checkpoint is saved. Follow progress on the Benchmarks
                        page.
                      </small>
                    </label>
                  </div>
                </details>
                {gpu && (
                  <label className="field">
                    <span>GPU time limit</span>
                    <select
                      value={draft.max_runtime_seconds}
                      onChange={(event) =>
                        update({ max_runtime_seconds: +event.target.value })
                      }
                    >
                      {[
                        ...new Set([
                          draft.max_runtime_seconds,
                          ...[3600, 14400, 43200, 86400].filter(
                            (value) => value <= capabilities.max_seconds,
                          ),
                        ]),
                      ]
                        .sort((a, b) => a - b)
                        .map((value) => (
                          <option key={value} value={value}>
                            {fmt(value / 3600, 1)} h · compute ceiling $
                            {fmt(
                              (value / 3600) * capabilities.max_hourly_usd,
                              2,
                            )}
                          </option>
                        ))}
                    </select>
                    <small>
                      Stops and saves before this limit. Startup and artifact
                      transfer use part of the time budget.
                    </small>
                  </label>
                )}
              </form>
              <div className="notice">
                {gpu
                  ? `Runs use a RunPod GPU. Maximum runtime: ${Math.round(capabilities.max_seconds / 60)} minutes; hourly price cap: $${capabilities.max_hourly_usd}. Checkpoints and logs are synchronized before the pod is terminated.`
                  : "Runs use this server’s CPU. A model file is saved when training finishes."}
              </div>
              <div className="actions">
                <button className="secondary" onClick={() => moveTo(1)}>
                  ← Dataset mix
                </button>
                <button className="primary" onClick={() => moveTo(3)}>
                  Review run →
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">Ready when you are</div>
              <h2>{draft.name}</h2>
              <p className="muted">
                Your data mix and settings will be saved with this run.
              </p>
              {fork && (
                <p className="notice">
                  Lineage:{" "}
                  <Link to={`/run/${encodeURIComponent(fork.parent.id)}`}>
                    {fork.parent.name}
                  </Link>{" "}
                  → this run, from checkpoint {fork.checkpoint.id} at step{" "}
                  {fmt(fork.checkpoint.step, 0)}. Launching creates a separate
                  run; the parent is unchanged.
                </p>
              )}
              {[
                ...(gpu
                  ? [
                      [
                        "GPU time limit",
                        `${fmt(draft.max_runtime_seconds / 3600, 1)} h`,
                      ],
                      [
                        "Compute cost ceiling",
                        `$${fmt((draft.max_runtime_seconds / 3600) * capabilities.max_hourly_usd, 2)} · up to $${capabilities.max_hourly_usd}/h`,
                      ],
                    ]
                  : []),
                ["Maximum steps", fmt(steps, 0)],
                [
                  "Early stopping",
                  draft.early_stopping
                    ? `On · ${draft.patience} checks without improvement of ${draft.min_delta}`
                    : "Off · full step budget, subject to runtime limit",
                ],
                ["Saved model", "Lowest validation loss checkpoint"],
                ["Batch size", `${draft.batch_size} sequences`],
                ["Learning rate", draft.learning_rate],
                ["LR schedule", draft.lr_schedule],
                [
                  "Automatic benchmark",
                  draft.auto_benchmark
                    ? draft.auto_benchmark_suite === "tiny_ml"
                      ? "Full Tiny-ML · WikiText-2 BYTE_PPL + BLiMP + ARC-Easy + ACI"
                      : `Full ${draft.auto_benchmark_suite}`
                    : "Off",
                ],
                ["Random seed", draft.seed],
                ["Maximum training budget", `${fmt(tokens, 0)} byte tokens`],
              ].map(([label, value]) => (
                <div className="legend" key={label}>
                  <span>{label}</span>
                  <b>{value}</b>
                </div>
              ))}
              <div className="divider" />
              <div className="notice">
                About 10% of each source’s documents are held out for
                validation; single-document sources use a 90/10 byte split.
                Validation checks progress without updating the model. Early
                stopping can finish before the step limit; the best validation
                checkpoint is saved.{" "}
                <Link to="/guide">Learn about validation and test data →</Link>
              </div>
              {warning}
              <div className="actions">
                <button
                  className="secondary"
                  disabled={launching}
                  onClick={() => moveTo(2)}
                >
                  ← Settings
                </button>
                <button
                  className="primary"
                  disabled={
                    launching || totalWeight !== 100 || Boolean(launchIssue)
                  }
                  onClick={() => void launch()}
                >
                  {launching
                    ? "Starting…"
                    : fork
                      ? "Launch fork ↗"
                      : "Start training ↗"}
                </button>
              </div>
            </>
          )}
        </section>
        <div className="studio-sidebar">
          <label className="field">
            <span>Compute</span>
            <select
              disabled={launching || Boolean(fork)}
              value={draft.compute}
              onChange={(event) =>
                update({
                  compute: event.target.value,
                  model_size: event.target.value === "runpod" ? "8m" : "tiny",
                  learning_rate:
                    event.target.value === "runpod" ? 0.0003 : 0.003,
                  budget_mode: "chinchilla",
                })
              }
            >
              <option value="runpod" disabled={!capabilities.runpod_available}>
                RunPod GPU · {capabilities.gpu || "GPU"}
              </option>
              <option value="cpu">Local CPU · tiny workflow test</option>
            </select>
          </label>
          {stage === 1 && (
            <button
              className="primary"
              disabled={totalWeight !== 100}
              onClick={() => moveTo(2)}
            >
              Training settings →
            </button>
          )}
          <aside className="panel aside">
            <h3>Your recipe</h3>
            <small>
              {mix.length} sources ·{" "}
              {precise
                ? `${totalWeight}% allocated`
                : `${points} / 20 points · ${totalWeight}% allocated`}
            </small>
            <div className="stack" aria-label="Dataset mix">
              {mix.map((dataset) => (
                <span
                  key={dataset.id}
                  style={{
                    width: `${dataset.weight / Math.max(100, totalWeight) * 100}%`,
                    background: datasetColor(dataset),
                  }}
                />
              ))}
            </div>
            {mix.map((dataset) => (
              <div className="legend" key={dataset.id}>
                <span>{dataset.name}</span>
                <b>{dataset.weight}%</b>
              </div>
            ))}
            <div className="divider" />
            {[
              [
                gpu ? "GPU training budget" : "GPU scale calculator",
                `${fmt((gpu ? tokens : draft.target_tokens) / 1e6, 2)}M tokens`,
              ],
              ["Model", modelName],
              ["Maximum training byte tokens", fmt(tokens, 0)],
              ["Planned byte tokens / parameter", fmt(tokens / parameters, 2)],
              ["Compute", computeName],
              ["Validation", "10% held out"],
            ].map(([label, value]) => (
              <div className="legend" key={label}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12, margin: "15px 0 0" }}>
              Percentages control how often each source is sampled, not its
              share of stored text.
            </p>
          </aside>
          {stage === 1 && (
            <details className="panel">
              <summary>
                Chinchilla · {fmt(scaleParameters / 1e6, 1)}M →{" "}
                {fmt(scaleTokens / 1e6, 0)}M tokens
              </summary>
              <section className="character" aria-labelledby="chinchilla-title">
                <div className="eyebrow">Chinchilla scaling laws</div>
                <h2 id="chinchilla-title">
                  How much data does the model need?
                </h2>
                <p className="muted">
                  A useful starting point: D ≈ 20 × N. A model twice as large
                  needs about twice as many tokens and four times as much
                  compute.
                </p>
                <div
                  className="character-buttons"
                  role="group"
                  aria-label="Planned parameter count"
                >
                  {[8, 16, 32, 64, 128, 150].map((value) => (
                    <button
                      key={value}
                      disabled={Boolean(fork) && gpu}
                      aria-pressed={
                        gpu
                          ? draft.model_size === `${value}m`
                          : value === scaleParameters / 1e6
                      }
                      onClick={() =>
                        update({
                          target_tokens: value * 20000000,
                          ...(gpu
                            ? {
                                model_size: `${value}m`,
                                budget_mode: "chinchilla",
                              }
                            : {}),
                        })
                      }
                    >
                      {value}M
                    </button>
                  ))}
                </div>
                <div className="fields">
                  <label className="field">
                    <span>Model parameters N (millions)</span>
                    <input
                      type="number"
                      min={0.005}
                      max={500}
                      step="any"
                      readOnly={gpu}
                      value={scaleParameters / 1e6}
                      onChange={(event) =>
                        update({
                          target_tokens: Math.max(
                            100000,
                            Math.min(
                              1e10,
                              (+event.target.value || 0.005) * 20000000,
                            ),
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Training tokens (millions)</span>
                    <input
                      type="number"
                      min={0.1}
                      max={10000}
                      step="any"
                      value={scaleTokens / 1e6}
                      onChange={(event) =>
                        update({
                          target_tokens: Math.max(
                            100000,
                            Math.min(
                              1e10,
                              Math.round(+event.target.value * 1e6) || 100000,
                            ),
                          ),
                          ...(gpu ? { budget_mode: "tokens" } : {}),
                        })
                      }
                    />
                  </label>
                </div>
                <p role="status" aria-live="polite">
                  {fmt(scaleParameters / 1e6, 3)}M parameters ×{" "}
                  {fmt(scaleTokens / scaleParameters, 2)} ≈{" "}
                  {fmt(scaleTokens / 1e6, 1)}M tokens
                </p>
                <p className="muted">
                  Estimated compute: C ≈ 6ND ≈{" "}
                  {(6 * scaleParameters * scaleTokens).toExponential(2)} FLOPs.
                  2× the scale → about 4× the compute.
                </p>
                <small>
                  {gpu
                    ? "Choosing a size changes the actual GPU model and sets a 20× budget. Tokenizer: UTF-8 bytes. Changing millions of tokens sets a custom budget. Early stopping and the time limit may end the run sooner."
                    : "This plans scale; it does not change the model being launched. Choose the CPU model and step limit later. The 20:1 rule comes from research on large models; this trainer uses bytes rather than subword tokens, so the same optimum is not guaranteed."}{" "}
                  <a
                    href="https://arxiv.org/abs/2203.15556"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Hoffmann et al., 2022 ↗
                  </a>
                </small>
              </section>
            </details>
          )}
        </div>
      </div>
      {preview && (
        <StudioDatasetReader
          key={preview.id}
          dataset={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
