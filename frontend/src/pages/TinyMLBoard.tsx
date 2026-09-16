import { useState } from "react";
import { useCustom } from "@refinedev/core";
interface Entry {
  id: string; run_id: string; run_name: string; model_size: string;
  provenance: { parameters: number; checkpoint_sha256: string; training_tokens?: number };
  results: Record<string, { accuracy?: number; acc_norm?: number; byte_perplexity?: number }>;
  tiny_ml_score: { overall: number; efficiency: number };
}
const number = (x?: number, digits = 2) => typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
export function TinyMLBoard() {
  const [sort, setSort] = useState("efficiency");
  const query = useCustom<{ items: Entry[]; protocol: string }>({
    url: "/api/benchmarks/tiny-ml", method: "get", queryOptions: { refetchInterval: 5000 },
  });
  const value = (e: Entry) => sort === "wiki" ? -(e.results.wikitext.byte_perplexity ?? Infinity) :
    sort === "blimp" ? e.results.blimp.accuracy ?? -1 : sort === "arc" ? e.results.arc_easy.accuracy ?? -1 :
    sort === "overall" ? e.tiny_ml_score.overall : e.tiny_ml_score.efficiency;
  const items = [...(query.query.data?.data.items || [])].sort((a, b) => value(b) - value(a));
  return <section className="panel" style={{ padding: 20, margin: "20px 0" }} aria-label="Private Tiny-ML leaderboard">
    <div className="row"><h2>My private Tiny-ML leaderboard</h2><span className="muted">Only you can see these results</span></div>
    <p>BLiMP · ARC-Easy · WikiText-2 byte perplexity. Run the Tiny-ML suite below to compare your checkpoints.</p>
    <p className="muted">Full evaluations only; one complete evaluation per checkpoint. Glint scoring uses frozen reference bounds, so adding models does not change earlier scores. External scores are not verified as directly comparable.</p>
    <label className="field"><span>Rank by</span><select value={sort} onChange={e => setSort(e.target.value)}>
      <option value="efficiency">Efficiency · size-adjusted score</option><option value="overall">Overall score</option>
      <option value="blimp">BLiMP</option><option value="arc">ARC-Easy</option><option value="wiki">WikiText-2 byte perplexity</option>
    </select></label>
    {query.query.error ? <p role="alert">Could not load your private leaderboard. <button onClick={() => void query.query.refetch()}>Retry</button></p> :
      query.query.isLoading ? <p>Loading private results…</p> : <div className="comparison-table"><table>
        <thead><tr><th>Model / checkpoint</th><th>Parameters</th><th>BLiMP ↑</th><th>ARC-Easy ↑</th><th>ARC acc_norm</th><th>Wiki byte PPL ↓</th><th>Overall ↑</th><th>Efficiency ↑</th></tr></thead>
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
