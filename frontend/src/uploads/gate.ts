import type { PrecheckReport } from "./precheck.ts";

interface KeyedFile {
  name: string;
  size: number;
  lastModified: number;
}

export interface UploadDraft {
  file?: KeyedFile;
  checkedFileKey?: string;
  report?: PrecheckReport;
  parametersValid: boolean;
}

export const fileKey = (file: KeyedFile) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

export function canStartUpload({ file, checkedFileKey, report, parametersValid }: UploadDraft) {
  if (!file || !report || !parametersValid) return false;
  return checkedFileKey === fileKey(file) && report.size === file.size && report.blocking.length === 0;
}
