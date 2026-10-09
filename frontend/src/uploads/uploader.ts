import { apiError } from "../provider.ts";
import { CLOSED_PHASES, PROCESSING_UPLOADING, TRANSFER_CLOSED, TRANSFER_READY } from "./display.ts";
import type { UploadForm } from "./form.ts";
import type { Hasher } from "./sha256.ts";

const CHUNK_BYTES = 8 * 1024 * 1024;
const PART_RETRIES = 3;
const READY_POLLS = 40;
const REQUEST_RETRIES = 4;

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
  // No abort signal: an abandoned in-flight create could still produce a job that holds the slot.
  const create = post({
    action_key: deps.newKey(),
    pipeline: form.pipeline,
    input: { format: form.format, encoded_bytes: file.size, sha256, filename: file.name },
    parameters: form.parameters,
    declaration: form.declaration,
  });
  const session = (await withRetries(deps, () => deps.call("/api/uploads", create))) as { job_id: string; part_size_bytes?: number };
  const job = `/api/uploads/${encodeURIComponent(session.job_id)}`;
  let confirm: RequestInit;
  try {
    signal?.throwIfAborted();
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
    confirm = post({ action_key: deps.newKey(), parts, encoded_bytes: file.size, input_sha256: sha256 });
  } catch (error) {
    // Without resume, an abandoned job would only hold the user's upload slot until its deadline.
    await cancelJob(job, deps);
    throw error;
  }
  onProgress?.({ phase: "confirming", loaded: file.size, total: file.size });
  try {
    await withRetries(deps, () => deps.call(`${job}/confirm`, confirm));
  } catch (error) {
    // The controller may have accepted a confirm whose response was lost; cancel only when that is ruled out.
    if (isDefiniteRefusal(error) || (await stillUploading(job, deps))) await cancelJob(job, deps);
    throw error;
  }
  return session.job_id;
}

function cancelJob(job: string, deps: UploaderDeps) {
  return deps.call(`${job}/cancel`, post({ action_key: deps.newKey() })).then(
    () => undefined,
    () => undefined,
  );
}

function isTransient(error: unknown) {
  const { status } = apiError(error);
  return status === undefined || status >= 500;
}

function isDefiniteRefusal(error: unknown) {
  const { status } = apiError(error);
  return status !== undefined && status >= 400 && status < 500;
}

async function stillUploading(job: string, deps: UploaderDeps) {
  try {
    return ((await deps.call(job)) as { processing_state?: string }).processing_state === PROCESSING_UPLOADING;
  } catch {
    return false;
  }
}

async function withRetries<T>(deps: UploaderDeps, attempt: () => Promise<T>) {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransient(error) || retry >= REQUEST_RETRIES) throw error;
      await deps.sleep(1000 * 2 ** retry);
    }
  }
}

async function waitUntilReady(job: string, deps: UploaderDeps, signal?: AbortSignal) {
  for (let attempt = 0; attempt < READY_POLLS; attempt++) {
    const status = (await deps.call(job, { signal }).catch((error) => {
      if (signal?.aborted || !isTransient(error)) throw error;
      return {};
    })) as { transfer_state?: string; client_phase?: string };
    if (status.transfer_state === TRANSFER_READY) return;
    if (status.transfer_state === TRANSFER_CLOSED || CLOSED_PHASES.has(status.client_phase ?? ""))
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
      if (signal?.aborted || isNonRetryableGrantError(error)) throw error;
    }
    if (attempt < PART_RETRIES) await deps.sleep(1000 * 2 ** attempt, signal);
  }
  if (hiddenEtag)
    throw new Error(`Part ${partNumber} was stored, but the storage response did not expose its ETag. Report this to the Track team.`);
  throw new Error(`Part ${partNumber} could not be uploaded. Check your connection and try again.`);
}

function isNonRetryableGrantError(error: unknown) {
  const { status, code } = apiError(error);
  return isDefiniteRefusal(error) && status !== 429 && code !== "transfer_not_ready";
}
