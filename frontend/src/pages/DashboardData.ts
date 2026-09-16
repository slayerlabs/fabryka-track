import { useRunQuery } from "./RunData";

export interface DashboardRun {
  id: string;
  name: string;
  project: string;
  experiment: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  parent_run_id: string | null;
  forked_from_checkpoint_id: string | null;
  config: Record<string, unknown>;
  latest_metrics: Record<string, number>;
  step: number | null;
  val_loss_history: { step: number; value: number }[];
  gpu_seconds: number | null;
  checkpoint_count: number;
  latest_checkpoint_id: string | null;
  best_checkpoint_id: string | null;
  can_fork: boolean;
}

export interface DashboardCheckpoint {
  id: string;
  run_id: string;
  run_name: string;
  step: number;
  val_loss: number | null;
  is_best: boolean;
  created_at: string;
  artifact_id: string | null;
  size: number | null;
  can_fork: boolean;
}

export interface Dashboard {
  runs: DashboardRun[];
  checkpoints: DashboardCheckpoint[];
  gpu_memory: {
    used_gb: number | null;
    total_gb: number | null;
    active_runs: number;
  };
}

export function useDashboard(enabled = true) {
  return useRunQuery<Dashboard>("/api/dashboard", 5000, enabled);
}
