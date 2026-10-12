import { sha256File } from "./sha256.ts";

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    const digest = await sha256File(data, (loaded) => self.postMessage({ loaded }));
    self.postMessage({ digest });
  } catch {
    self.postMessage({ failed: true });
  }
};
