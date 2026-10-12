import { COPY } from "./copy.ts";
import type { SliceableFile } from "./uploader.ts";

type Reply = { loaded: number } | { digest: string } | { failed: true };

export type HashWorker = Pick<Worker, "onmessage" | "onerror" | "postMessage" | "terminate">;

export function hashInWorker(
  createWorker: () => HashWorker,
  file: SliceableFile,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    signal?.throwIfAborted();
    const unreadable = () => new Error(COPY.progress.fileUnreadable);
    let worker: HashWorker;
    try {
      worker = createWorker();
    } catch {
      throw unreadable();
    }
    const finish = () => {
      worker.onmessage = worker.onerror = null;
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort);
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if ("loaded" in data) return onProgress(data.loaded);
      finish();
      if ("digest" in data) resolve(data.digest);
      else reject(unreadable());
    };
    worker.onerror = () => {
      finish();
      reject(unreadable());
    };
    worker.postMessage(file);
  });
}
