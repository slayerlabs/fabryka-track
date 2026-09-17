import { useState } from "react";
import { useCustom } from "@refinedev/core";
import { compareBenchmarkValues, type BenchmarkSort } from "./BenchmarkSort";
interface Entry {
  id: string; run_id: string; run_name: string; model_size: string;
  provenance: { parameters: number; checkpoint_sha256: string; training_tokens?: number };
  results: Record<string, { accuracy?: number; acc_norm?: number; byte_perplexity?: number }>;
  tiny_ml_score: { overall: number; efficiency: number };
}
const number = (x?: number, digits = 2) => typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
const columns = [
  { key: "model", label: "Model / checkpoint", direction: "asc", value: (e: Entry) => e.run_name },
  { key: "parameters", label: "Parameters", direction: "asc", value: (e: Entry) => e.provenance.parameters },
  { key: "blimp", label: "BLiMP", direction: "desc", value: (e: Entry) => e.results.blimp?.accuracy },
  { key: "arc", label: "ARC-Easy", direction: "desc", value: (e: Entry) => e.results.arc_easy?.accuracy },
  { key: "arc_norm", label: "ARC acc_norm", direction: "desc", value: (e: Entry) => e.results.arc_easy?.acc_norm },
  { key: "wiki", label: "Wiki byte PPL", direction: "asc", value: (e: Entry) => e.results.wikitext?.byte_perplexity },
  { key: "overall", label: "Overall", direction: "desc", value: (e: Entry) => e.tiny_ml_score.overall },
  { key: "efficiency", label: "Efficiency", direction: "desc", value: (e: Entry) => e.tiny_ml_score.efficiency },
] as const;
export function TinyMLBoard() {
  const [sort, setSort] = useState<BenchmarkSort>({ key: "efficiency", direction: "desc" });
  const query = useCustom<{ items: Entry[]; protocol: string }>({
    url: "/api/benchmarks/tiny-ml", method: "get", queryOptions: { refetchInterval: 5000 },
  });
  const column = columns.find(column => column.key === sort.key)!;
  const items = [...(query.query.data?.data.items || [])].sort((a, b) =>
    compareBenchmarkValues(column.value(a), column.value(b), sort.direction));
  return <section className="panel" style={{ padding: 20, margin: "20px 0" }} aria-label="Private Tiny-ML leaderboard">
    <div className="row"><h2>My private Tiny-ML leaderboard</h2><span className="muted">Only you can see these results</span></div>
    <p>BLiMP · ARC-Easy · WikiText-2 byte perplexity. Run the Tiny-ML suite below to compare your checkpoints.</p>
    <p className="muted">Full evaluations only; one complete evaluation per checkpoint. Glint scoring uses frozen reference bounds, so adding models does not change earlier scores. External scores are not verified as directly comparable.</p>
    <label className="field"><span>Rank by</span><select value={sort.key} onChange={e => {
      const column = columns.find(column => column.key === e.target.value)!;
      setSort({ key: column.key, direction: column.direction });
    }}>
      {columns.map(column => <option key={column.key} value={column.key}>{column.label}</option>)}
    </select></label>
    {query.query.error ? <p role="alert">Could not load your private leaderboard. <button onClick={() => void query.query.refetch()}>Retry</button></p> :
      query.query.isLoading ? <p>Loading private results…</p> : <div className="comparison-table"><table>
        <thead><tr>{columns.map(column => <th key={column.key}
          aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" className="secondary" title={"Sort by " + column.label} onClick={() =>
            setSort({ key: column.key, direction: sort.key === column.key
              ? (sort.direction === "asc" ? "desc" : "asc") : column.direction })}>
            {column.label} {sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
          </button>
        </th>)}</tr></thead>
        <tbody>{items.map(e => <tr key={e.id}>
          <td><a href={"/run/" + e.run_id}>{e.run_name}</a><small style={{ display: "block" }}>{e.provenance.checkpoint_sha256?.slice(0, 12)}</small></td>
          <td>{number(e.provenance.parameters / 1e6)}M</td>
          <td>{number((e.results.blimp.accuracy ?? NaN) * 100)}%</td>
          <td>{number((e.results.arc_easy.accuracy ?? NaN) * 100)}%</td>
          <td>{number((e.results.arc_easy.acc_norm ?? NaN) * 100)}%</td>
          <td>{number(e.results.wikitext.byte_perplexity, 4)}</td>
          <td>{number(e.tiny_ml_score.overall)}</td><td>{number(e.tiny_ml_score.efficiency)}</td>
        </tr>)}</tbody></table>{!items.length && <p>No complete Tiny-ML evaluations yet. Smoke checks appear in evaluation history and do not enter this ranking.</p>}</div>}
    <details><summary>Scoring and reproducibility</summary><p>Overall = mean of BLiMP accuracy, raw ARC-Easy accuracy and log-normalized WikiText-2 byte perplexity, on a 0–100 scale. Efficiency adds a log-parameter size bonus from 1× to 1.5×; it does not measure GPU cost.</p>
      <p>Frozen bounds: Wiki byte PPL 1.86–500; parameters 1,000–150,000,000. Zero-shot lm-eval 0.4.13, pinned dataset revisions, byte-level sliding context. BLiMP averages all 67 subtasks. ARC acc_norm is shown separately and does not enter the aggregate.</p>
      <p>These evaluations stay private even when a run is public. <a href="https://huggingface.co/spaces/Glint-Research/Tiny-ML-Leaderboard" target="_blank" rel="noreferrer">Glint reference leaderboard</a> · reference revision 3fce60372675.</p>
    </details>
  </section>;
}
