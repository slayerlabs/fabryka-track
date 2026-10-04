import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "./contract.ts";
import type { ConfirmUpload, CreateUpload, FileMetadata, TransferGrant, UploadSession } from "./types.ts";
import { ApiError, MAX_RETRIES, PROTOCOL, PipelineApi, backoff } from "./api.ts";

const HASH_CHUNK_BYTES = 1048576;
const MAX_INPUT_BYTES = 536870912;
const PUT_TIMEOUT_MS = 120000;
const READY_POLL_MS = 2000;
// Renew a grant this close to expiry so storage never rejects a request already in flight.
const GRANT_SKEW_MS = 5000;

type Parts = ConfirmUpload["parts"];

// Mirrors the controller's inspect_input signatures; the controller stays authoritative.
const UNSUPPORTED = [
  [0x25, 0x50, 0x44, 0x46],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a],
  [0x28, 0xb5, 0x2f, 0xfd],
];
const PAR1 = [0x50, 0x41, 0x52, 0x31];
const USTAR = [0x75, 0x73, 0x74, 0x61, 0x72];

const startsWith = (bytes: Uint8Array, magic: number[], offset = 0) =>
  magic.every((byte, index) => bytes[offset + index] === byte);

const expired = () => new ApiError(410, "expired", false);

export function newOperationKey(): string {
  return crypto.randomUUID();
}

export async function sha256File(file: File, signal: AbortSignal,
  progress: (bytes: number) => void): Promise<string> {
  const hash = sha256.create();
  for (let start = 0; start < file.size; start += HASH_CHUNK_BYTES) {
    signal.throwIfAborted();
    const chunk = new Uint8Array(await file.slice(start, start + HASH_CHUNK_BYTES).arrayBuffer());
    hash.update(chunk);
    progress(Math.min(start + chunk.length, file.size));
  }
  return bytesToHex(hash.digest());
}

export async function detectFormat(file: Blob): Promise<CreateUpload["format"]> {
  if (file.size < 1) throw new ApiError(0, "empty_file", false);
  if (file.size > MAX_INPUT_BYTES) throw new ApiError(0, "file_too_large", false);
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (UNSUPPORTED.some((magic) => startsWith(head, magic)) || startsWith(head, USTAR, 257)) {
    throw new ApiError(0, "unsupported_format", false);
  }
  if (!startsWith(head, PAR1)) return "jsonl";
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4)).arrayBuffer());
  if (file.size < 12 || !startsWith(tail, PAR1)) throw new ApiError(0, "unsupported_format", false);
  return "parquet";
}

export function createBody(file: File, metadata: FileMetadata, inputSha256: string,
  format: CreateUpload["format"]): CreateUpload {
  const cleaned = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== "" && value !== undefined));
  const body: CreateUpload = { protocol: PROTOCOL, metadata: cleaned as FileMetadata, format,
    encoded_bytes: file.size, input_sha256: inputSha256 };
  if (file.name && file.name.length <= 255 && !/[\\/]/.test(file.name)) body.filename = file.name;
  try {
    return decode<CreateUpload>("CreateUpload", body);
  } catch {
    throw new ApiError(0, "invalid_request", false);
  }
}

export function assertSameInput(session: UploadSession, file: File, inputSha256: string): void {
  if (session.encoded_bytes !== file.size || session.input_sha256 !== inputSha256) {
    throw new ApiError(0, "input_mismatch", false);
  }
}

async function awaitReady(api: PipelineApi, jobId: string, deadline: number,
  signal: AbortSignal): Promise<void> {
  for (;;) {
    if (api.now() >= deadline) throw expired();
    await api.sleep(READY_POLL_MS, signal);
    const status = await api.status(jobId, signal);
    if (status.client_phase === "expired") throw expired();
    if (status.processing_state !== "uploading" || status.transfer_state === "closed") {
      throw new ApiError(409, "invalid_state", false);
    }
    if (status.transfer_state === "ready") return;
  }
}

async function grantFor(api: PipelineApi, session: UploadSession, number: number, deadline: number,
  signal: AbortSignal): Promise<TransferGrant> {
  for (;;) {
    if (api.now() >= deadline) throw expired();
    try {
      return await api.part(session.job_id, number, signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "transfer_not_ready") throw error;
      await awaitReady(api, session.job_id, deadline, signal);
    }
  }
}

async function putPart(api: PipelineApi, session: UploadSession, body: Blob, number: number,
  deadline: number, signal: AbortSignal): Promise<string> {
  let grant: TransferGrant | null = null;
  for (let retry = 0; ; retry++) {
    if (!grant || api.now() >= Date.parse(grant.expires_at) - GRANT_SKEW_MS) {
      grant = await grantFor(api, session, number, deadline, signal);
    }
    const remaining = deadline - api.now();
    if (remaining <= 0) throw expired();
    const timeout = AbortSignal.timeout(Math.min(PUT_TIMEOUT_MS, remaining));
    let status = 0;
    try {
      const response = await api.transport(grant.url, {
        method: "PUT", credentials: "omit", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", body,
        headers: { "Content-Type": "application/octet-stream" },
        signal: AbortSignal.any([signal, timeout]),
      });
      status = response.status;
      if (response.ok) {
        const etag = response.headers.get("ETag");
        if (!etag) throw new ApiError(status, "storage_etag_missing", false);
        return etag;
      }
      if (status === 403) grant = null;
      else if (status !== 408 && status !== 429 && status < 500) {
        throw new ApiError(status, "storage_transfer_failed", false);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) throw signal.reason;
      if (!timeout.aborted) throw new ApiError(0, "network_lost", true);
    }
    if (retry >= MAX_RETRIES) throw new ApiError(status, "storage_transfer_failed", true);
    await api.sleep(backoff(retry), signal);
  }
}

export async function uploadParts(api: PipelineApi, session: UploadSession, file: File,
  signal: AbortSignal, progress: (bytes: number) => void, completed: Parts = []): Promise<ConfirmUpload> {
  if (file.size !== session.encoded_bytes || file.size < 1) throw new ApiError(0, "file_size_mismatch", false);
  const deadline = Date.parse(session.upload_deadline);
  const size = session.part_size_bytes;
  const count = Math.ceil(file.size / size);
  const partBytes = (number: number) => Math.min(size, file.size - (number - 1) * size);
  const numbers = completed.map((part) => part.part_number);
  if (numbers.some((n) => n < 1 || n > count) || new Set(numbers).size !== numbers.length) {
    throw new ApiError(0, "input_mismatch", false);
  }
  if (api.now() >= deadline) throw expired();
  if (session.transfer_state === "pending") await awaitReady(api, session.job_id, deadline, signal);
  const done = new Set(completed.map((part) => part.part_number));
  let sent = [...done].reduce((total, number) => total + partBytes(number), 0);
  if (sent > 0) progress(sent);
  for (let number = 1; number <= count; number++) {
    if (done.has(number)) continue;
    signal.throwIfAborted();
    const start = (number - 1) * size;
    const etag = await putPart(api, session, file.slice(start, start + size), number, deadline, signal);
    completed.push({ part_number: number, etag });
    sent += partBytes(number);
    progress(sent);
  }
  const parts = [...completed].sort((a, b) => a.part_number - b.part_number);
  // the controller accepts only exactly 1..count; fail here rather than with a non-retryable remote 422
  if (parts.length !== count || parts.some((part, index) => part.part_number !== index + 1)) {
    throw new ApiError(0, "input_mismatch", false);
  }
  return { protocol: PROTOCOL, parts, encoded_bytes: file.size, input_sha256: session.input_sha256 };
}
