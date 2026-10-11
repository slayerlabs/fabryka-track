import type { ReactNode } from "react";
import type { UploadJob } from "./api.ts";
import { describeJob } from "./display.ts";
import { size, when } from "../pages/Uploads.tsx";

export function JobFacts({ job }: { job: UploadJob }) {
  const described = describeJob(job);
  const facts: [string, ReactNode][] = [
    ["Pipeline", job.pipeline],
    ["Phase", described.phase],
    ["Outcome", described.outcome],
    ["Input size", size(job.encoded_bytes)],
    ["Input SHA-256", <code>{job.input_sha256 ?? "—"}</code>],
    ["Upload started", when(job.upload_started_at)],
    ["Upload deadline", when(job.upload_deadline)],
    ["Admitted", when(job.admitted_at)],
    ["First result stored", when(job.first_result_stored_at)],
    ["Expires", when(job.expires_at)],
  ];

  return (
    <table aria-label="Upload facts" style={{ tableLayout: "fixed", overflowWrap: "anywhere" }}>
      <tbody>
        {facts.map(([label, value]) => (
          <tr key={label}>
            <th scope="row" style={{ width: "40%" }}>{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
