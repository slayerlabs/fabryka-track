export const tinyMLProtocol = "tiny-ml-en-v2-byte-sliding-aci";
export const isTinyML = (protocol?: string) => protocol?.startsWith("tiny-ml-") ?? false;

export interface TinyMLMeasurement {
  accuracy?: number;
  byte_perplexity?: number;
  aci_score?: number;
  priority_score?: number;
  linkage_score?: number;
  samples?: number;
  skipped?: number;
  error?: string;
}

export const tinyMLMetrics = [
  { key: "wikitext", label: "WikiText-2 BYTE_PPL", field: "byte_perplexity", direction: "asc", unit: "lower is better" },
  { key: "blimp", label: "BLiMP", field: "accuracy", direction: "desc", unit: "higher is better" },
  { key: "arc_easy", label: "ARC-Easy", field: "accuracy", direction: "desc", unit: "higher is better" },
  { key: "aci", label: "ACI", field: "aci_score", direction: "desc", unit: "0–100 · higher is better" },
] as const;

export function tinyMLValue(result: TinyMLMeasurement | undefined, field: "accuracy" | "byte_perplexity" | "aci_score") {
  const value = result?.[field];
  if (result?.error || typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (field === "byte_perplexity" ? value <= 0 : value < 0 || value > (field === "accuracy" ? 1 : 100)) return undefined;
  return value;
}

export function formatTinyML(value: number | undefined, field: "accuracy" | "byte_perplexity" | "aci_score") {
  if (value === undefined) return "—";
  return field === "accuracy" ? (value * 100).toFixed(2) + "%" : value.toFixed(field === "byte_perplexity" ? 4 : 2);
}

export function TinyMLDetails({ evaluation: e }: { evaluation: {
  protocol?: string;
  mode: string;
  status: string;
  current_task?: string;
  results: Record<string, TinyMLMeasurement>;
  tiny_ml_score?: { overall: number; efficiency: number } | null;
} }) {
  const current = e.protocol === tinyMLProtocol;
  const measured = tinyMLMetrics.filter(metric => tinyMLValue(e.results[metric.key], metric.field) !== undefined).length;
  const complete = current && e.mode === "full" && e.status === "finished" && measured === 4;
  const active = ["queued", "running"].includes(e.status);
  return <section className="panel" style={{ padding: 16, margin: "12px 0" }}>
    <b>{e.mode === "smoke" ? "Tiny-ML smoke check — not a full benchmark" : complete ? "Tiny-ML · complete four-metric evaluation" : "Tiny-ML · not a complete four-metric evaluation"}</b>
    <p className="muted">{e.protocol} · {measured}/4 metrics measured · {e.status}
      {!current && " · Legacy protocol — retained as history, not eligible for the current ranking."}
    </p>
    <div style={{ overflowX: "auto" }}>
    <table>
      <thead><tr><th>Benchmark</th><th>Measurement</th><th>Examples</th><th>Skipped</th></tr></thead>
      <tbody>{tinyMLMetrics.map(metric => {
        const result = e.results[metric.key];
        const value = tinyMLValue(result, metric.field);
        return <tr key={metric.key}>
          <td>{metric.label}<small style={{ display: "block" }}>{metric.unit}</small></td>
          <td>{result?.error ? `Failed: ${result.error}` : value !== undefined ? formatTinyML(value, metric.field)
            : !current && metric.key === "aci" ? "Not measured by this legacy protocol"
            : e.current_task === metric.key && e.status === "running" ? "Running…"
            : active ? "Pending" : "Missing measurement"}
            {metric.key === "aci" && value !== undefined && <small style={{ display: "block" }}>
              Priority {typeof result?.priority_score === "number" && Number.isFinite(result.priority_score) ? result.priority_score.toFixed(2) : "—"}
              {" · Linkage "}{typeof result?.linkage_score === "number" && Number.isFinite(result.linkage_score) ? result.linkage_score.toFixed(2) : "—"}
            </small>}
          </td>
          <td>{result?.samples ?? "—"}</td><td>{result?.skipped ?? "—"}</td>
        </tr>;
      })}</tbody>
    </table>
    </div>
    <p className="muted">ACI is Attention Clarity Index (0–100), measured with gradient-times-attention on the native byte model. It is not ARC normalized accuracy or an aggregate score. Context truncation and dataset revisions are recorded with the evaluation metrics.</p>
    {complete && e.tiny_ml_score && <p>Secondary three-metric scores: Overall {e.tiny_ml_score.overall.toFixed(2)} · Efficiency {e.tiny_ml_score.efficiency.toFixed(2)}. ACI is not included in either formula.</p>}
  </section>;
}
