import { useCustom, useCustomMutation, type BaseRecord } from "@refinedev/core";
import { useEffect, useRef, useState } from "react";
import { request } from "../provider";

export type Point = {
  step: number;
  value: number;
  timestamp?: string;
  tokens?: number;
};
export type RunConfig = {
  model?: string;
  model_size?: string;
  compute?: string;
  steps?: number;
  planned_training_tokens?: number;
  tokenizer_vocab_size?: number;
  batch_size?: number;
  learning_rate?: number;
  seed?: number;
  [key: string]: unknown;
};
export type RunMetadata = {
  engine?: string;
  gpu_cleanup?: string;
  training_result?: {
    stop_reason?: string;
    best_step?: number;
    best_val_loss?: number;
    best_val_perplexity?: number;
    completed_steps?: number;
  };
  tracking?: {
    tokens_seen?: number;
    step?: number;
    received_at?: string;
    source_updated_at?: string;
    process_alive?: boolean;
    checkpoint?: { tokens: number; step: number };
  };
};
export type GPUStatus = {
  cleanup_done?: boolean;
  phase?: string;
  queue_position?: number;
  gpu?: string;
  hourly_usd?: number;
  error?: string;
  deadline?: string;
  cost?: {
    basis?: string;
    complete?: boolean;
    estimated_usd?: number;
    hourly_usd?: number;
    billed_usd?: number;
  };
};
export type Run = {
  id: string;
  name: string;
  project: string;
  state: string;
  started_at: string;
  config: RunConfig;
  metadata: RunMetadata;
  metrics: Record<string, Point[]>;
  latest_metrics?: Record<string, number>;
  gpu_status?: GPUStatus;
  read_only?: boolean;
  is_public?: boolean;
  note?: string;
  conclusion?: string;
  logs?: { level: string; message: string }[];
  artifacts?: { id: string; name: string }[];
};
export const activeRun = (r: Run) =>
  ["queued", "running", "stopping"].includes(r.state);
export const latest = (r: Run, key: string) =>
  r.metrics?.[key]?.at(-1)?.value ?? r.latest_metrics?.[key];
export const fmt = (value: unknown, digits = 3) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "—";
export const pct = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? (value * 100).toFixed(1) + "%"
    : "—";
export const duration = (seconds: number) =>
  !Number.isFinite(seconds)
    ? "Measuring…"
    : seconds < 60
      ? `${Math.ceil(seconds)}s`
      : seconds < 3600
        ? `${Math.ceil(seconds / 60)} min`
        : `${(seconds / 3600).toFixed(1)} h`;
export function useRunQuery<T extends BaseRecord>(
  url: string,
  interval: number | false | ((data: T | undefined) => number | false) = false,
  enabled = true,
) {
  const { query } = useCustom<T>({
    url,
    method: "get",
    queryOptions: {
      enabled,
      retry: false,
      queryFn: async ({ signal }) => ({
        data: await request<T>(url, { signal }),
      }),
      refetchInterval: (q) =>
        typeof interval === "function"
          ? interval(q.state.data?.data)
          : interval,
    },
  });
  return { ...query, data: query.data?.data };
}
export function useRunAction() {
  const { mutateAsync } = useCustomMutation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((c) => c.abort());
      controllers.current.clear();
    };
  }, []);
  async function execute<T extends BaseRecord = Record<string, unknown>>(
    url: string,
    values: Record<string, unknown> = {},
    method: "post" | "patch" | "delete" = "post",
  ): Promise<T | undefined> {
    const controller = new AbortController();
    controllers.current.add(controller);
    setPending(true);
    setError("");
    try {
      const result = await mutateAsync({
        url,
        method,
        values,
        meta: { signal: controller.signal },
        errorNotification: false,
      });
      return mounted.current ? (result.data as T) : undefined;
    } catch (e) {
      if (mounted.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      controllers.current.delete(controller);
      if (mounted.current) setPending(controllers.current.size > 0);
    }
  }
  return { execute, pending, error, setError };
}
export function RunError({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error instanceof Error ? error.message : String(error)}
      {retry && (
        <button className="secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function RangeControls({
  range,
  setRange,
  layout,
  setLayout,
}: {
  range: number;
  setRange: (n: number) => void;
  layout: string;
  setLayout: (s: string) => void;
}) {
  return (
    <>
      <select
        aria-label="Visible training range"
        value={range}
        onChange={(e) => setRange(Number(e.target.value))}
      >
        <option value="0">All steps</option>
        <option value="0.1">Skip first 10%</option>
        <option value="0.5">Latest half</option>
      </select>
      <select
        aria-label="Chart layout"
        value={layout}
        onChange={(e) => setLayout(e.target.value)}
      >
        <option value="grid">Mosaic</option>
        <option value="column">One column</option>
      </select>
    </>
  );
}
