import type { UploadJob, UploadPipeline } from "./api";
import { formatBytes } from "./bytes";
import { describeJob, formatWhen, modeLabel } from "./display";

export function JobFacts({ job, pipelines }: { job: UploadJob; pipelines: UploadPipeline[] }) {
  const described = describeJob(job);
  return (
    <div className="table-scroll">
      <table>
        <tbody>
          <tr><th>Mode</th><td>{modeLabel(job.pipeline, pipelines)}</td></tr>
          <tr><th>Phase</th><td>{described.phase}</td></tr>
          <tr><th>Outcome</th><td>{described.outcome}</td></tr>
          <tr><th>Size</th><td>{job.encoded_bytes == null ? "—" : formatBytes(job.encoded_bytes)}</td></tr>
          <tr><th>SHA-256</th><td><code>{job.input_sha256 ?? "—"}</code></td></tr>
          <tr><th>Upload started</th><td>{formatWhen(job.upload_started_at)}</td></tr>
          <tr><th>Upload deadline</th><td>{formatWhen(job.upload_deadline)}</td></tr>
          <tr><th>Admitted</th><td>{formatWhen(job.admitted_at)}</td></tr>
          <tr><th>Result stored</th><td>{formatWhen(job.first_result_stored_at)}</td></tr>
          <tr><th>Expires</th><td>{formatWhen(job.expires_at)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
