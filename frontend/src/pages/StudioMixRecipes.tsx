import type { Dataset } from "./StudioDatasetReader";
import { findRecipeDataset, ivmeSources, ivmeWeights, type RecipeSource } from "./StudioMixData";

export function StudioMixRecipes({ datasets, onImport, onApply }: {
  datasets: Dataset[];
  onImport: (source: RecipeSource) => void;
  onApply: (weights: Record<string, number>) => void;
}) {
  const weights = ivmeWeights(datasets);
  const ready = ivmeSources.filter((source) => findRecipeDataset(source, datasets)).length;
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
      <small><a href="https://huggingface.co/IvmeLabs/Ivme-Conversate-v3-Base/blob/65a61bee44474a6b981d7deb8a40bb8410b5ad08/README.md" target="_blank" rel="noreferrer">Published Ivme v3 recipe ↗</a></small>
    </section>
  );
}
