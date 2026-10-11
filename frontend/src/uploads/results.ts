import type { UploadJob, UploadReport } from "./api.ts";
import { describeJob } from "./display.ts";

export interface ResultsDeps {
  getUpload(id: string, signal?: AbortSignal): Promise<UploadJob>;
  getReport(id: string, signal?: AbortSignal): Promise<UploadReport>;
}

export interface UploadResults {
  job: UploadJob;
  report: UploadReport | null;
  reportError: string;
}

export async function loadUploadResults(
  id: string,
  deps: ResultsDeps,
  signal?: AbortSignal,
): Promise<UploadResults> {
  signal?.throwIfAborted();
  const job = await deps.getUpload(id, signal);
  signal?.throwIfAborted();
  if (!describeJob(job).hasReport || job.client_phase === "expired") {
    return { job, report: null, reportError: "" };
  }
  try {
    const report = await deps.getReport(id, signal);
    signal?.throwIfAborted();
    return { job, report, reportError: "" };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      job,
      report: null,
      reportError: error instanceof Error ? error.message : "Something went wrong. Try again.",
    };
  }
}
