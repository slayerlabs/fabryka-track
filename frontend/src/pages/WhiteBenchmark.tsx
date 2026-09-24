import { useRunQuery, fmt } from "./RunData";

type Status = {
  status: string;
  detail?: string;
  repo_id?: string;
  revision?: string;
  result?: { scope?: string; metrics?: Record<string, number> };
};
export function WhiteBenchmark({ id }: { id: string }) {
  const query = useRunQuery<Status>(`/api/runs/${encodeURIComponent(id)}/white-benchmark`, 15000);
  const data = query.data;
  if (!data) return null;
  return <section className="checkpoint-protocol-note" aria-label="Automatic benchmarks">
    <h3>Automatic benchmarks</h3>
    <p>{data.status.replaceAll("_", " ")} · WikiText-2, BLiMP, ARC-Easy and ACI</p>
    {data.detail && <p>{data.detail}</p>}
    {data.repo_id && <p>Model: {data.repo_id} · revision <code>{data.revision}</code></p>}
    {data.result?.scope && <p>Evaluation scope: {data.result.scope}</p>}
    {data.result?.metrics && <dl>{Object.entries(data.result.metrics).map(([name, value]) =>
      <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{fmt(value, 4)}</dd></div>)}</dl>}
  </section>;
}
