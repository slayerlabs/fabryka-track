import type { PrecheckReport } from "./precheck.ts";

export interface FilePrecheck {
  file: File;
  report: PrecheckReport;
}

export function precheckFor(file: File | null, checked: FilePrecheck | null): PrecheckReport | null {
  return file !== null && checked?.file === file ? checked.report : null;
}
