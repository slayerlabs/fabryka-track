import { useMemo, useState } from "react";
import { fmt, RunError, useRunAction, useRunQuery } from "./RunData";

type Item = {
  id: string;
  checkpoint_step: number;
  status: "queued" | "running" | "finished" | "failed";
  source: string;
  score: number | null;
  scoring_seconds?: number | null;
  historical_heldout_mae?: number | null;
  metrics?: Record<string, { accuracy_pct?: number; byte_perplexity?: number }>;
  error?: string | null;
  created_at: string;
};
type Snapshot = { step: number; sha256: string; tokens?: number; bytes?: number };
type ProxyState = {
  protocol: string;
  latest_checkpoint: Snapshot | null;
  schedule: { interval_steps?: number | null; next_step?: number | null };
  items: Item[];
};

function time(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function Trend({ items }: { items: Item[] }) {
  const [alpha, setAlpha] = useState(0.25);
  const data = useMemo(
    () =>
      items
        .filter((item) => item.status === "finished" && item.score !== null)
        .sort((a, b) => a.checkpoint_step - b.checkpoint_step),
    [items],
  );
  if (!data.length) return <p className="muted">Scores will appear here after the first evaluation.</p>;
  const width = 720, height = 220, left = 48, right = 18, top = 16, bottom = 32;
  const scores = data.map((item) => item.score as number);
  const low = Math.min(...scores), high = Math.max(...scores);
  const pad = Math.max(0.2, (high - low) * 0.2);
  const minY = low - pad, maxY = high + pad;
  const minX = data[0].checkpoint_step, maxX = data.at(-1)!.checkpoint_step;
  const point = (item: Item, index: number) => {
    const x = maxX === minX ? (left + width - right) / 2 : left + ((item.checkpoint_step - minX) / (maxX - minX)) * (width - left - right);
    const y = top + ((maxY - (item.score as number)) / (maxY - minY)) * (height - top - bottom);
    return [x, y] as const;
  };
  let ema = scores[0];
  const smooth = data.map((item, i) => {
    ema = i === 0 ? scores[i] : alpha * scores[i] + (1 - alpha) * ema;
    return point({ ...item, score: ema }, i);
  });
  const d = smooth.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <b>Proxy score by checkpoint</b>
        <label className="field" style={{ margin: 0, minWidth: 150 }}>
          <span>EMA smoothing</span>
          <select value={alpha} onChange={(event) => setAlpha(Number(event.target.value))}>
            <option value={0.5}>Responsive · 0.50</option>
            <option value={0.25}>Balanced · 0.25</option>
            <option value={0.1}>Steady · 0.10</option>
          </select>
        </label>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Raw GLINT proxy scores and EMA-smoothed trend" style={{ width: "100%", height: "auto", minHeight: 170, marginTop: 8 }}>
        {[0, 1, 2, 3].map((i) => {
          const y = top + i * ((height - top - bottom) / 3);
          const value = maxY - i * ((maxY - minY) / 3);
          return <g key={i}><line x1={left} x2={width - right} y1={y} y2={y} stroke="#d7e0d5" /><text x={left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#716b65">{value.toFixed(2)}</text></g>;
        })}
        <path d={d} fill="none" stroke="#4a8677" strokeWidth="2.5" />
        {data.map((item, i) => {
          const [x, y] = point(item, i);
          return <circle key={item.id} cx={x} cy={y} r="4.5" fill="#b94e32" stroke="#fffdfa" strokeWidth="1.5"><title>{`Step ${item.checkpoint_step.toLocaleString()}: ${item.score?.toFixed(3)}`}</title></circle>;
        })}
        <text x={left} y={height - 8} fontSize="11" fill="#716b65">step {minX.toLocaleString()}</text>
        {maxX !== minX && <text x={width - right} y={height - 8} textAnchor="end" fontSize="11" fill="#716b65">step {maxX.toLocaleString()}</text>}
      </svg>
      <small className="muted"><span style={{ color: "#b94e32" }}>●</span> raw score · <span style={{ color: "#4a8677" }}>—</span> EMA trend · higher is better</small>
    </div>
  );
}

export function GlintProxyBenchmark({ id }: { id: string }) {
  const url = `/api/runs/${encodeURIComponent(id)}/glint-proxy`;
  const query = useRunQuery<ProxyState>(url, (data) =>
    data?.items.some((item) => item.status === "queued" || item.status === "running") || data?.schedule.interval_steps ? 10000 : false,
  );
  const action = useRunAction();
  const state = query.data;
  const busy = state?.items.some((item) => item.status === "queued" || item.status === "running");
  const latest = state?.latest_checkpoint;
  const scheduleValue = state?.schedule.interval_steps ? String(state.schedule.interval_steps) : "off";
  const rows = [...(state?.items || [])].sort((a, b) => b.checkpoint_step - a.checkpoint_step);
  return (
    <section className="panel" style={{ margin: "24px 0", padding: 22 }} aria-label="GLINT fast proxy">
      <RunError error={query.error} retry={() => void query.refetch()} />
      <RunError error={action.error} />
      <div className="row" style={{ justifyContent: "space-between", gap: 16, alignItems: "start" }}>
        <div>
          <h2 style={{ marginTop: 0 }}>GLINT fast proxy</h2>
          <p className="muted" style={{ maxWidth: 760, marginTop: 4 }}>
            Score saved Slayer149 checkpoints on the CPU in a background worker. Training keeps running on both GPUs. This 2,620-item proxy estimates the leaderboard trend; it is not the full benchmark.
          </p>
        </div>
        <div className="metric" style={{ minWidth: 180 }}>
          <small>Latest saved checkpoint</small>
          <strong>{latest ? `step ${latest.step.toLocaleString()}` : "Waiting for checkpoint"}</strong>
        </div>
      </div>
      <div className="fields" style={{ alignItems: "end", margin: "16px 0" }}>
        <button className="secondary" disabled={!latest || busy || action.pending} onClick={async () => {
          if (await action.execute(url + "/evaluate")) await query.refetch();
        }}>
          {busy ? "Evaluation queued or running…" : "Evaluate latest checkpoint"}
        </button>
        <label className="field" style={{ maxWidth: 300 }}>
          <span>Automatic checkpoint evaluation</span>
          <select value={scheduleValue} disabled={action.pending} onChange={async (event) => {
            const interval = event.target.value === "off" ? null : Number(event.target.value);
            if (await action.execute(url + "/schedule", { interval_steps: interval })) await query.refetch();
          }}>
            <option value="off">Off</option>
            <option value="500">Every 500 steps</option>
            <option value="1000">Every 1,000 steps</option>
            <option value="2000">Every 2,000 steps</option>
            <option value="5000">Every 5,000 steps</option>
          </select>
        </label>
        {state?.schedule.next_step && <small className="muted">Next scheduled checkpoint: step {state.schedule.next_step.toLocaleString()}</small>}
      </div>
      <Trend items={rows} />
      {rows.length > 0 && <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table><thead><tr><th>Checkpoint</th><th>Status</th><th>Proxy score</th><th>Scoring time</th><th>Requested</th></tr></thead>
          <tbody>{rows.slice(0, 12).map((item) => <tr key={item.id}>
            <td>{item.checkpoint_step.toLocaleString()}</td><td>{item.status.replaceAll("_", " ")}</td>
            <td>{item.score === null ? "—" : fmt(item.score, 3)}</td>
            <td>{item.scoring_seconds == null ? "—" : `${fmt(item.scoring_seconds, 1)} s`}</td><td>{time(item.created_at)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {rows.some((item) => item.status === "finished") && <p className="muted" style={{ marginBottom: 0 }}>
        Checkpoint evaluations are private to this run owner. The fixed proxy uses the same examples and recipe each time; score estimates have historical calibration error and small batch/numeric variation.
      </p>}
    </section>
  );
}
