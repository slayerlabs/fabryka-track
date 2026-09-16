import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";
import { Link, useNavigate } from "react-router";
import { request } from "../provider";
import { LoginPage, type StudioUser } from "./Account";
import { corpusSources } from "./StudioData";
import { StudioHFDatasets } from "./StudioHFDatasets";
import { StudioDatasetReader, type Dataset } from "./StudioDatasetReader";
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
      architecture: { context_length: number; layers: number };
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
  auto_benchmark: boolean;
  auto_benchmark_suite: string;
  character: string | null;
  training_budget_version: number;
  point_budget_version: number;
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
  auto_benchmark: true,
  auto_benchmark_suite: "piqa",
  character: null,
  training_budget_version: 1,
  point_budget_version: 1,
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
  ] as const)
    if (typeof saved[key] === "number" && Number.isFinite(saved[key]))
      draft[key] = saved[key];
  for (const key of ["early_stopping", "auto_benchmark"] as const)
    if (typeof saved[key] === "boolean") draft[key] = saved[key];
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
    Object.values(weights).some((weight) => weight % 5 !== 0) ||
    Object.values(weights).reduce((sum, weight) => sum + weight, 0) > 100
      ? allocatePoints(
          datasets.map((dataset) => ({
            id: dataset.id,
            size: weights[dataset.id],
          })),
        )
      : weights;
  return draft;
}

export function StudioPage() {
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
  return user ? <StudioLoader key={user.id} user={user} /> : <LoginPage />;
}

function StudioLoader({ user }: { user: StudioUser }) {
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
  return (
    <TrainingStudio
      user={user}
      datasets={datasets}
      capabilities={capabilities.query.data.data}
      onRefresh={refresh}
    />
  );
}

function TrainingStudio({
  user,
  datasets,
  capabilities,
  onRefresh,
}: {
  user: StudioUser;
  datasets: Dataset[];
  capabilities: Capabilities;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    restoreDraft(user.id, datasets, capabilities),
  );
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
    try {
      localStorage.setItem(
        `training-draft-v3:${user.id}`,
        JSON.stringify(draft),
      );
    } catch {
      /* Keep the current draft usable when storage is unavailable. */
    }
  }, [draft, user.id]);
  useEffect(() => () => controller.current?.abort(), []);
  const mix = datasets
    .filter((dataset) => (draft.weights[dataset.id] || 0) > 0)
    .map((dataset) => ({ ...dataset, weight: draft.weights[dataset.id] }));
  const points = mix.reduce((sum, dataset) => sum + dataset.weight / 5, 0);
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
    setDraft((previous) => ({ ...previous, ...patch }));
  }
  function balance(id: string, value: number) {
    setDraft((previous) => {
      const used = datasets.reduce(
        (sum, dataset) => sum + (previous.weights[dataset.id] || 0) / 5,
        0,
      );
      const availablePoints = 20 - used + (previous.weights[id] || 0) / 5;
      return {
        ...previous,
        character: null,
        weights: {
          ...previous.weights,
          [id]: Math.max(0, Math.min(Math.round(value), availablePoints)) * 5,
        },
      };
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
      weights: allocatePoints(
        selected.map((dataset) => ({ id: dataset.id, size: dataset.bytes })),
      ),
    });
    setProfileMessage("");
  }
  function moveTo(next: number) {
    if (stage === 2 && !setup.current?.reportValidity()) return;
    if (next > 1 && points !== 20) return;
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
    if (points !== 20 || launching) return;
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
          patience: 20,
          min_delta: 0.01,
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
        <h1>A model starts with a mix.</h1>
        <p className="muted">
          Choose your data, train a model, and follow its progress live.
        </p>
      </div>
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
              <section className="character" aria-labelledby="character-title">
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
                        aria-label={`Remove a point: ${dataset.name}`}
                        onClick={() => balance(dataset.id, weight / 5 - 1)}
                      >
                        −
                      </button>
                      <input
                        id={`slider-${dataset.id}`}
                        type="range"
                        min={0}
                        max={20}
                        step={1}
                        value={weight / 5}
                        aria-label={`${dataset.name} points`}
                        onChange={(event) =>
                          balance(dataset.id, +event.target.value)
                        }
                        style={{ accentColor: datasetColor(dataset) }}
                      />
                      <button
                        type="button"
                        className="point-control"
                        disabled={points >= 20}
                        aria-label={`Add a point: ${dataset.name}`}
                        onClick={() => balance(dataset.id, weight / 5 + 1)}
                      >
                        +
                      </button>
                      <output
                        className="percent"
                        htmlFor={`slider-${dataset.id}`}
                      >
                        {weight / 5} points · {weight}%
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
                  layers, {context}-byte context. Initialized from scratch.
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
                    All models train from scratch on the selected compute. GPU
                    models use a 512-byte context.
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
                      {[1, 2, 4, 8, 16, 32].map((value) => (
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
                        step={0.0001}
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
                    Early stopping · 20 validation checks without an improvement
                    of 0.01
                  </label>
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
                    ? "On · 20 checks without improvement"
                    : "Off · full step budget, subject to runtime limit",
                ],
                ["Saved model", "Lowest validation loss checkpoint"],
                ["Batch size", `${draft.batch_size} sequences`],
                ["Learning rate", draft.learning_rate],
                ["LR schedule", draft.lr_schedule],
                [
                  "Automatic benchmark",
                  draft.auto_benchmark
                    ? `Full ${draft.auto_benchmark_suite}`
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
                  disabled={launching || points !== 20}
                  onClick={() => void launch()}
                >
                  {launching ? "Starting…" : "Start training ↗"}
                </button>
              </div>
            </>
          )}
        </section>
        <div className="studio-sidebar">
          <label className="field">
            <span>Compute</span>
            <select
              disabled={launching}
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
              disabled={points !== 20}
              onClick={() => moveTo(2)}
            >
              Training settings →
            </button>
          )}
          <aside className="panel aside">
            <h3>Your recipe</h3>
            <small>
              {mix.length} sources · {points} / 20 points · {points * 5}%
              allocated
            </small>
            <div className="stack" aria-label="Dataset mix">
              {mix.map((dataset) => (
                <span
                  key={dataset.id}
                  style={{
                    width: `${dataset.weight}%`,
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
                  {[8, 16, 32, 64, 128].map((value) => (
                    <button
                      key={value}
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
