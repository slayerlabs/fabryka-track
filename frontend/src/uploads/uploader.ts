import type { UploadForm } from "./form";
import type { Hasher } from "./sha256";

const CHUNK_BYTES = 8 * 1024 * 1024;
const PART_RETRIES = 3;
const READY_POLLS = 40;

export interface SliceableFile {
  name: string;
  size: number;
  slice(start: number, end: number): Blob;
}


export interface UploadProgress {
  phase: "hashing" | "preparing" | "uploading" | "confirming";
  loaded: number;
  total: number;
}

export interface UploaderDeps {
  call: (path: string, init?: RequestInit) => Promise<unknown>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  createHash: () => Hasher;
  newKey: () => string;
}

interface Options {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

interface Grant {
  method: string;
  url: string;
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  signal,
});

export async function hashFile(
  file: SliceableFile,
  hasher: Hasher,
  { signal, onProgress }: Options = {},
) {
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    onProgress?.({ phase: "hashing", loaded: end, total: file.size });
  }
  return hasher.digest();
}

export async function uploadFile(
  file: SliceableFile,
  form: UploadForm,
  deps: UploaderDeps,
  options: Options = {},
) {
  const { signal, onProgress } = options;
  if (file.size === 0) throw new Error("The file is empty.");
  const sha256 = await hashFile(file, deps.createHash(), options);
  onProgress?.({ phase: "preparing", loaded: 0, total: file.size });
  const session = (await deps.call(
    "/api/uploads",
    post(
      {
        action_key: deps.newKey(),
        input: { format: form.format, encoded_bytes: file.size, sha256, filename: file.name },
        parameters: form.parameters,
        declaration: form.declaration,
      },
      signal,
    ),
  )) as { job_id: string; part_size_bytes?: number };
  const job = `/api/uploads/${encodeURIComponent(session.job_id)}`;
  try {
    await waitUntilReady(job, deps, signal);
    const partSize = session.part_size_bytes || CHUNK_BYTES;
    const parts: { part_number: number; etag: string }[] = [];
    for (let start = 0; start < file.size; start += partSize) {
      const end = Math.min(file.size, start + partSize);
      const partNumber = parts.length + 1;
      parts.push({ part_number: partNumber, etag: await sendPart(job, partNumber, file.slice(start, end), deps, signal) });
      signal?.throwIfAborted();
      onProgress?.({ phase: "uploading", loaded: end, total: file.size });
    }
    onProgress?.({ phase: "confirming", loaded: file.size, total: file.size });
    await deps.call(
      `${job}/confirm`,
      post({ action_key: deps.newKey(), parts, encoded_bytes: file.size, input_sha256: sha256 }, signal),
    );
  } catch (error) {
    // Without resume, an abandoned job would only hold the user's upload slot until its deadline.
    await deps.call(`${job}/cancel`, post({ action_key: deps.newKey() })).catch(() => undefined);
    throw error;
  }
  return session.job_id;
}

async function waitUntilReady(job: string, deps: UploaderDeps, signal?: AbortSignal) {
  for (let attempt = 0; attempt < READY_POLLS; attempt++) {
    const status = (await deps.call(job, { signal }).catch((error) => {
      if (signal?.aborted) throw error;
      return {};
    })) as { transfer_state?: string; client_phase?: string };
    if (status.transfer_state === "ready") return;
    if (status.client_phase === "expired" || status.client_phase === "rejected")
      throw new Error("The upload was closed before the file could be sent.");
    await deps.sleep(Math.min(5000, 500 * 1.5 ** attempt), signal);
  }
  throw new Error("The upload was not ready for transfer in time. Try again later.");
}

async function sendPart(job: string, partNumber: number, body: Blob, deps: UploaderDeps, signal?: AbortSignal) {
  let hiddenEtag = false;
  for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
    signal?.throwIfAborted();
    hiddenEtag = false;
    try {
      const grant = (await deps.call(`${job}/parts`, post({ part_number: partNumber }, signal))) as Grant;
      const response = await deps.fetch(grant.url, { method: grant.method, body, signal });
      const etag = response.headers.get("ETag");
      if (response.ok && etag) return etag;
      hiddenEtag = response.ok;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt < PART_RETRIES) await deps.sleep(1000 * 2 ** attempt, signal);
  }
  if (hiddenEtag)
    throw new Error(`Part ${partNumber} was stored, but the storage response did not expose its ETag. Report this to the Track team.`);
  throw new Error(`Part ${partNumber} could not be uploaded. Check your connection and try again.`);
}
