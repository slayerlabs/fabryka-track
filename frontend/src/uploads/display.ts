import type { UploadProgress } from "./uploader";

export function humanize(code?: string | null) {
  if (!code) return "—";
  const words = code.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function bindingLabel(binding?: boolean) {
  if (binding === undefined) return "—";
  return binding ? "Required" : "Advisory";
}

export function stoppedMessage(phase: UploadProgress["phase"]) {
  return phase === "hashing" ? "Upload stopped." : "Upload stopped. The job was cancelled.";
}
