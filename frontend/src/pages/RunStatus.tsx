import { activeRun, duration, fmt, latest, type Run } from "./RunData";

export function RunStatus({ run: r }: { run: Run }) {
  if (r.metadata.engine === "external-training") {
    const t = r.metadata.tracking || {},
      seen = t.tokens_seen || 0,
      target = r.config.planned_training_tokens || 0;
    const fresh =
      Date.now() - Date.parse(t.received_at || "") < 60000 &&
      Date.now() - Date.parse(t.source_updated_at || "") < 120000 &&
      t.process_alive;
    const active = r.state === "running",
      rate = latest(r, "throughput/tokens_sec") || 0;
    return (
      <section className="notice" aria-label="Live training progress">
        <div className="row">
          <strong>
            {active
              ? fresh
                ? "Training in progress · live"
                : "Progress feed delayed — last known running"
              : r.state}
          </strong>
          <span>{fmt(target ? (seen / target) * 100 : 0, 2)}%</span>
        </div>
        <progress
          max="100"
          value={target ? Math.min(100, (seen / target) * 100) : 0}
          aria-label="Training token progress"
        />
        <p>
          {fmt(seen / 1e6, 2)}M / {fmt(target / 1e9, 1)}B tokenizer tokens ·{" "}
          {fmt(t.step || 0, 0)} optimizer updates
        </p>
        {active && fresh && rate > 0 && (
          <p>
            ETA at current update rate: approximately{" "}
            {duration(Math.max(0, target - seen) / rate)}. Checkpoint and other
            overhead can extend this.
          </p>
        )}
        <small>
          {t.received_at
            ? `Last synchronized: ${new Date(t.received_at).toLocaleString()}`
            : "Waiting for the first synchronization."}
          {t.checkpoint &&
            ` · Latest local checkpoint: ${fmt(t.checkpoint.tokens / 1e6, 2)}M tokens (step ${t.checkpoint.step})`}
        </small>
        <p className="muted">
          No validation measurements have been reported
          {r.metrics?.["validation/bpb"]?.length
            ? " for token loss or perplexity; held-out BPB appears below"
            : " yet"}
          . Training loss alone does not establish quality on unseen text.
        </p>
      </section>
    );
  }
  const g = r.gpu_status;
  if (!g) return null;
  const speed = latest(r, "throughput/tokens_sec") || 0,
    seen = latest(r, "training/tokens_seen") || 0;
  const remaining = Math.max(0, (r.config.planned_training_tokens || 0) - seen);
  const phase = g.cleanup_done
    ? r.state
    : r.metadata.gpu_cleanup === "pending"
      ? "Saving artifacts and terminating GPU"
      : g.phase === "queued"
        ? `Waiting in queue · position ${g.queue_position}`
        : g.phase === "provisioning"
          ? "Allocating GPU and starting container"
          : seen
            ? "Training"
            : "Starting CUDA and downloading datasets";
  const c = g.cost;
  return (
    <div className="notice gpu-status">
      <div className="row">
        <b>{phase}</b>
        <span>
          {g.gpu || "GPU not assigned"}
          {g.hourly_usd ? ` · $${fmt(g.hourly_usd, 2)}/h` : ""}
        </span>
      </div>
      {g.error && <p role="status">{g.error}</p>}
      {activeRun(r) && (
        <small>
          {speed > 0
            ? `ETA to token limit: ${duration(remaining / speed)} · ${fmt(speed, 0)} byte tokens/s measured. Early stopping may finish sooner.`
            : "Waiting for measured throughput to estimate time."}
          {g.deadline &&
            ` · Time limit: ${new Date(g.deadline).toLocaleTimeString()}`}
        </small>
      )}
      {c &&
        (c.basis === "no_pod" ? (
          c.complete && (
            <small className="muted">
              GPU cost: $0.0000 · no pod allocated
            </small>
          )
        ) : (
          <small
            className="muted"
            title="Estimate: GPU rate × time from allocation to pod release. Excludes evaluations, VPS and storage."
          >
            Cost:{" "}
            <b>
              {c.estimated_usd != null
                ? `$${c.estimated_usd.toFixed(4)} ${c.complete ? "total" : "so far"}`
                : "estimating…"}
            </b>
            {c.hourly_usd != null && ` · $${c.hourly_usd.toFixed(4)}/h`}
            {c.billed_usd != null
              ? ` · billed $${c.billed_usd.toFixed(4)}`
              : " · billed: pending"}
          </small>
        ))}
    </div>
  );
}
