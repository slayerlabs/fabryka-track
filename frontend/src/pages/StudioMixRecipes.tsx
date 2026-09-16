import { useEffect, useState } from "react";
import { useCustom, useCustomMutation } from "@refinedev/core";

import type { Dataset } from "./StudioDatasetReader";
import { findRecipeDataset, ivmeSources, ivmeWeights, type RecipeSource } from "./StudioMixData";

interface MixJob {
  id: string;
  state: string;
  config: { kind?: string; model_size?: string; target_tokens?: number };
  progress: { current_source?: string; bytes?: number };
  error?: string;
}
const active = (job: MixJob) => ["queued", "running"].includes(job.state);

export function StudioMixRecipes({ datasets, onImport, onApply, onImported }: {
  datasets: Dataset[];
  onImport: (source: RecipeSource) => void;
  onApply: (weights: Record<string, number>) => void;
  onImported: () => void;
}) {
  const weights = ivmeWeights(datasets);
  const ready = ivmeSources.filter((source) => findRecipeDataset(source, datasets)).length;
  const [premixJobId, setPremixJobId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const { mutateAsync: premixMutation } = useCustomMutation<MixJob>();
  const { query } = useCustom<MixJob[]>({
    url: "/api/hf-datasets/imports",
    method: "get",
    queryOptions: {
      queryKey: ["studio-imports-premix"],
      enabled: !!premixJobId,
      refetchInterval: (query) =>
        query.state.data?.data.some((item) => item.id === premixJobId && active(item)) ? 2000 : false,
    },
  });
  const job = query.data?.data.find((item) => item.id === premixJobId);
  useEffect(() => {
    if (job?.state !== "finished") return;
    onImported();
    setPremixJobId(undefined);
  }, [job]);
  return (
    <section className="panel recipe-preset" aria-labelledby="ivme-mix-title">
      <div className="eyebrow">Dataset recipe</div>
      <h2 id="ivme-mix-title">Ivme v3 · English</h2>
      <p className="muted">Educational web, general web, encyclopedic text, math and stories. Import the six sources, then apply their exact shares.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Source / subset</th><th>Share</th><th>In your library</th></tr></thead>
          <tbody>{ivmeSources.map((source) => {
            const dataset = findRecipeDataset(source, datasets);
            return <tr key={source.repo}>
              <td><a href={`https://huggingface.co/datasets/${source.repo}`} target="_blank" rel="noreferrer">{source.name}</a><br /><small>{source.config}</small></td>
              <td>{source.weight.toFixed(2)}%</td>
              <td>{dataset ? <span title={dataset.name}>Ready · {(dataset.bytes / 1e6).toFixed(1)} MB</span> : <button type="button" className="secondary" onClick={() => onImport(source)}>Prepare import<span className="runs-sr-only">: {source.name}</span></button>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="muted">Start with up to 10 MB per source; you can increase the sample size before importing. Imports run one at a time and use bounded samples, not the full corpora. FineWeb-Edu uses sample-10BT as a starter subset.</p>
      <p className="muted">Track applies these shares to byte-token sampling. This is a data-mix preset, not a reproduction of Ivme’s model or 15B-token training run. Your model size and training budget stay unchanged.</p>
      <div className="hf-actions">
        <button type="button" className="primary" disabled={!weights} onClick={() => weights && onApply(weights)}>Apply Ivme mix</button>
        <span role="status">{ready}/6 sources ready · 100% total</span>
      </div>
      <div className="hf-actions">
        <button
          type="button"
          className="secondary"
          disabled={starting || (!!premixJobId && job?.state !== "failed")}
          onClick={async () => {
            setStarting(true);
            try {
              const response = await premixMutation({ url: "/api/hf-datasets/ivme-mix", method: "post", values: { model_size: "150m" } });
              setPremixJobId(response.data.id);
            } finally {
              setStarting(false);
            }
          }}
        >
          Pre-mix a 150M-sized dataset
        </button>
        <span role="status">
          {premixJobId
            ? job
              ? `Importing ${job.progress.current_source ?? "sources"}… ${((job.progress.bytes ?? 0) / 1e6).toFixed(0)} MB so far`
              : "Starting…"
            : "Fetches all six sources at once, sized for a chinchilla-optimal 150M run (~3B tokens), and saves them as one ready-to-train dataset — skips per-source review."}
        </span>
      </div>
      {job?.state === "failed" && <p className="error" role="alert">{job.error}</p>}
      <small><a href="https://huggingface.co/IvmeLabs/Ivme-Conversate-v3-Base/blob/65a61bee44474a6b981d7deb8a40bb8410b5ad08/README.md" target="_blank" rel="noreferrer">Published Ivme v3 recipe ↗</a></small>
    </section>
  );
}
