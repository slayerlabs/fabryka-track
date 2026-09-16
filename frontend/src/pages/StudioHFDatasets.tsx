import { useEffect, useRef, useState } from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";

import type { RecipeSource } from "./StudioMixData";

interface Source {
  repo: string;
  revision: string;
  config: string | null;
  split: string;
}
interface Inspection extends Source {
  configs: string[];
  splits: string[];
  columns: { name: string; text: boolean }[];
  notice?: string;
}
interface Rule {
  column: string;
  operator: string;
  value: string;
}
interface Filters {
  text_column: string;
  max_mb: number;
  min_chars: number;
  max_chars: number;
  contains: string;
  excludes: string;
  deduplicate: boolean;
  rules: Rule[];
}
interface Preview {
  stats: { accepted: number; scanned: number };
  samples: string[];
}
interface ImportJob {
  id: string;
  state: string;
  config: Source & { max_mb: number };
  progress: { bytes?: number; accepted?: number };
  error?: string;
}
const initialFilters: Filters = {
  text_column: "text",
  max_mb: 3000,
  min_chars: 100,
  max_chars: 100000,
  contains: "",
  excludes: "",
  deduplicate: true,
  rules: [],
};
const active = (job: ImportJob) => ["queued", "running"].includes(job.state);

export function StudioHFDatasets({
  onImported,
  userId,
  recipeRequest,
}: {
  onImported: () => void;
  userId: string;
  recipeRequest?: { source: RecipeSource; nonce: number };
}) {
  const [repo, setRepo] = useState("");
  const [info, setInfo] = useState<Inspection | null>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const seen = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const imported = useRef(onImported);
  imported.current = onImported;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { query } = useCustom<ImportJob[]>({
    url: "/api/hf-datasets/imports",
    method: "get",
    queryOptions: {
      queryKey: ["studio-imports", userId],
      refetchInterval: (query) =>
        query.state.data?.data.some(active) ? 2000 : false,
    },
  });
  const { mutateAsync: inspectMutation } = useCustomMutation<Inspection>();
  const { mutateAsync: previewMutation } = useCustomMutation<Preview>();
  const { mutateAsync: importMutation } = useCustomMutation<ImportJob>();
  const jobs = query.data?.data;
  useEffect(() => {
    if (!jobs) return;
    const finished = jobs.some(
      (job) => job.state === "finished" && seen.current.has(job.id),
    );
    seen.current = new Set(jobs.filter(active).map((job) => job.id));
    if (seen.current.size) setOpen(true);
    if (finished) {
      imported.current();
      setMessage("Dataset imported. Apply a recipe or adjust its share to include it.");
    }
  }, [jobs]);
  const handledRecipe = useRef(0);
  useEffect(() => {
    if (!recipeRequest || busy || handledRecipe.current === recipeRequest.nonce) return;
    handledRecipe.current = recipeRequest.nonce;
    setOpen(true);
    setRepo(recipeRequest.source.repo);
    void inspect(recipeRequest.source, recipeRequest.source);
    document.getElementById("hf-import")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [recipeRequest, busy]);

  async function inspect(source: Partial<Source> & { repo: string }, recipe?: RecipeSource) {
    if (busy) return;
    setBusy(true);
    setMessage("Inspecting public dataset…");
    setInfo(null);
    setPreview(null);
    try {
      const response = await inspectMutation({
        url: "/api/hf-datasets/inspect",
        method: "post",
        values: source,
      });
      if (!mounted.current) return;
      const data = response.data;
      setInfo(data);
      const texts = data.columns
        .filter((column) => column.text)
        .map((column) => column.name);
      setFilters({
        ...initialFilters,
        text_column: recipe?.text_column || (texts.includes("text") ? "text" : texts[0] || ""),
        max_mb: recipe ? 10 : initialFilters.max_mb,
      });
      setMessage("");
    } catch (e) {
      if (mounted.current)
        setMessage(
          e instanceof Error ? e.message : "Could not inspect this dataset.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(mode: "preview" | "import") {
    if (!info || busy || !form.current?.reportValidity()) return;
    if (filters.min_chars > filters.max_chars) {
      setMessage("Minimum length exceeds maximum length.");
      return;
    }
    const rules = filters.rules.filter((rule) => rule.column);
    if (
      rules.some(
        (rule) =>
          ["gte", "lte"].includes(rule.operator) &&
          !Number.isFinite(Number(rule.value)),
      )
    ) {
      setMessage("Numeric filters need a finite number.");
      return;
    }
    const values = {
      repo: info.repo,
      revision: info.revision,
      config: info.config,
      split: info.split,
      ...filters,
      rules,
    };
    setBusy(true);
    setMessage(
      mode === "preview" ? "Checking the first 200 rows…" : "Starting import…",
    );
    try {
      if (mode === "preview") {
        const response = await previewMutation({
          url: "/api/hf-datasets/preview",
          method: "post",
          values,
        });
        if (!mounted.current) return;
        setPreview(response.data);
        setMessage(
          response.data.stats.accepted
            ? "Preview ready."
            : "No matches in the preview. Try less restrictive filters.",
        );
      } else {
        const response = await importMutation({
          url: "/api/hf-datasets/imports",
          method: "post",
          values,
        });
        if (!mounted.current) return;
        seen.current.add(response.data.id);
        setMessage("Importing… You can leave this page.");
        await query.refetch();
      }
    } catch (e) {
      if (mounted.current)
        setMessage(
          e instanceof Error ? e.message : "Could not import this dataset.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const changeRule = (index: number, patch: Partial<Rule>) =>
    setFilters((previous) => ({
      ...previous,
      rules: previous.rules.map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule,
      ),
    }));
  const renderJob = (job: ImportJob) => (
    <div className="hf-job" key={job.id}>
      <div className="hf-job-heading">
        <b title={job.config.repo}>{job.config.repo.split("/").pop()}</b>
        <span>{job.state === "finished" ? "Ready" : job.state}</span>
        <small>
          {((job.progress.bytes || 0) / 1e6).toFixed(1)} MB ·{" "}
          {(job.progress.accepted || 0).toLocaleString()} docs
        </small>
      </div>
      {active(job) && (
        <progress
          max={job.config.max_mb || 100}
          value={(job.progress.bytes || 0) / 1e6}
          aria-label="Imported megabytes"
        />
      )}
      {job.error && <small role="alert">{job.error}</small>}
    </div>
  );
  return (
    <details
      id="hf-import"
      className="panel hf-import"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <b>Import from Hugging Face</b>
      </summary>
      <p className="muted">
        Paste a public dataset link. No HF connection needed.
      </p>
      <form
        className="hf-source"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect({ repo: repo.trim() });
        }}
      >
        <label className="field">
          <input
            value={repo}
            onChange={(event) => {
              setRepo(event.target.value);
              setInfo(null);
              setPreview(null);
            }}
            required
            maxLength={300}
            disabled={busy}
            aria-label="Dataset URL or owner/name"
            placeholder="https://huggingface.co/datasets/owner/dataset"
          />
        </label>
        <button className="secondary" disabled={busy}>
          Continue →
        </button>
      </form>
      <button
        className="preview-link"
        type="button"
        disabled={busy}
        onClick={() => {
          setRepo("nvidia/Nemotron-ClimbMix");
          void inspect({ repo: "nvidia/Nemotron-ClimbMix" });
        }}
      >
        Try NVIDIA ClimbMix
      </button>
      {info && (
        <>
          {info.repo === "nvidia/Nemotron-ClimbMix" && (
            <p className="muted">English · CC BY-NC 4.0 · non-commercial use</p>
          )}
          {info.columns.some((column) => column.text) ? (
            <form
              ref={form}
              onSubmit={(event) => {
                event.preventDefault();
                void submit("import");
              }}
            >
              <fieldset
                disabled={busy}
                style={{ border: 0, padding: 0, minWidth: 0 }}
              >
                <div className="hf-main-options">
                  <label className="field">
                    <span>Sample size (MB)</span>
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      required
                      value={filters.max_mb}
                      onChange={(event) =>
                        setFilters({ ...filters, max_mb: +event.target.value })
                      }
                    />
                  </label>
                  <span className="muted">
                    Up to 5,000 MB · 3,000 MB ≈ 3 GB
                  </span>
                </div>
                <details className="hf-advanced">
                  <summary>Filters & source options</summary>
                  <div className="hf-grid">
                    <label className="field">
                      <span>Subset</span>
                      <select
                        value={info.config || ""}
                        onChange={(event) =>
                          void inspect({
                            repo,
                            config: event.target.value,
                            split: info.split,
                          })
                        }
                      >
                        {info.configs.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Split</span>
                      <select
                        value={info.split}
                        onChange={(event) =>
                          void inspect({
                            repo,
                            config: info.config,
                            split: event.target.value,
                          })
                        }
                      >
                        {info.splits.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Text column</span>
                      <select
                        value={filters.text_column}
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            text_column: event.target.value,
                          })
                        }
                      >
                        {info.columns
                          .filter((column) => column.text)
                          .map((column) => (
                            <option key={column.name}>{column.name}</option>
                          ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Minimum characters</span>
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        required
                        value={filters.min_chars}
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            min_chars: +event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Maximum characters</span>
                      <input
                        type="number"
                        min={100}
                        max={250000}
                        required
                        value={filters.max_chars}
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            max_chars: +event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Must contain</span>
                      <input
                        maxLength={300}
                        placeholder="Optional keyword"
                        value={filters.contains}
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            contains: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Must not contain</span>
                      <input
                        maxLength={300}
                        placeholder="Optional keyword"
                        value={filters.excludes}
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            excludes: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={filters.deduplicate}
                      onChange={(event) =>
                        setFilters({
                          ...filters,
                          deduplicate: event.target.checked,
                        })
                      }
                    />{" "}
                    Remove exact duplicates
                  </label>
                  {filters.rules.map((rule, index) => (
                    <div className="hf-rule" key={index}>
                      <select
                        aria-label="Filter column"
                        value={rule.column}
                        onChange={(event) =>
                          changeRule(index, { column: event.target.value })
                        }
                      >
                        <option value="">Column</option>
                        {info.columns.map((column) => (
                          <option key={column.name}>{column.name}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Filter condition"
                        value={rule.operator}
                        onChange={(event) =>
                          changeRule(index, { operator: event.target.value })
                        }
                      >
                        <option value="equals">Equals</option>
                        <option value="contains">Contains</option>
                        <option value="gte">At least</option>
                        <option value="lte">At most</option>
                      </select>
                      <input
                        maxLength={300}
                        required={!!rule.column}
                        aria-label="Filter value"
                        placeholder="Value"
                        value={rule.value}
                        onChange={(event) =>
                          changeRule(index, { value: event.target.value })
                        }
                      />
                      <button
                        className="secondary"
                        type="button"
                        aria-label="Remove filter"
                        onClick={() =>
                          setFilters({
                            ...filters,
                            rules: filters.rules.filter((_, i) => i !== index),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="preview-link"
                    disabled={filters.rules.length >= 5}
                    onClick={() =>
                      setFilters({
                        ...filters,
                        rules: [
                          ...filters.rules,
                          { column: "", operator: "equals", value: "" },
                        ],
                      })
                    }
                  >
                    + Add column filter
                  </button>
                  <small className="muted" style={{ display: "block" }}>
                    All filters must match. Text matching ignores case.
                  </small>
                  <small
                    className="muted"
                    style={{ display: "block", marginTop: 8 }}
                  >
                    Revision {info.revision.slice(0, 12)} ·{" "}
                    {info.notice ||
                      "Use a training split to keep evaluation data held out."}
                  </small>
                </details>
                <p className="muted">
                  First matching documents; not a representative sample.
                </p>
                <div className="hf-actions">
                  <button className="primary">Import dataset</button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void submit("preview")}
                  >
                    Preview
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p>No supported text column found.</p>
          )}
        </>
      )}
      {preview && (
        <div aria-live="polite">
          <p>
            <b>
              {preview.stats.accepted} matches / {preview.stats.scanned} preview
              rows
            </b>
          </p>
          {preview.samples.map((text, index) => (
            <pre
              key={index}
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 180,
                overflow: "auto",
                padding: 12,
                background: "var(--bg)",
              }}
            >
              {text}
            </pre>
          ))}
        </div>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      <div aria-live="polite">
        {jobs?.filter(active).map(renderJob)}
        {!!jobs?.some((job) => !active(job)) && (
          <details>
            <summary>
              Recent imports · {jobs.filter((job) => !active(job)).length}
            </summary>
            {jobs
              .filter((job) => !active(job))
              .slice(0, 5)
              .map(renderJob)}
          </details>
        )}
      </div>
    </details>
  );
}
