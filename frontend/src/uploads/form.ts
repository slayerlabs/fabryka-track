export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DECLARATION_VERSION = "upload-declaration-v0-placeholder";
export const DECLARATION_TEXT =
  "I confirm that I have the right to share this data for processing and publication, and that the licence I give is truthful.";

export interface UploadForm {
  format: "jsonl" | "parquet";
  parameters: Record<string, string | boolean>;
  declaration: { accepted: true; version: string };
}

export interface UploadFormState {
  file: { name: string; size: number } | null;
  source: string;
  added: string;
  license: string;
  author: string;
  source_ref: string;
  per_record_provenance: boolean;
  mask_names: "yes" | "no" | "";
  declaration: boolean;
}

export type UploadErrors = Partial<Record<keyof UploadFormState, string>>;

export function formatFor(name: string): UploadForm["format"] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".parquet")) return "parquet";
  return null;
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateUpload(state: UploadFormState): { errors: UploadErrors; form?: UploadForm } {
  const errors: UploadErrors = {};
  const format = state.file ? formatFor(state.file.name) : null;
  if (!state.file) errors.file = "Choose a file to upload.";
  else if (!format) errors.file = "Choose a .jsonl or .parquet file.";
  else if (state.file.size === 0) errors.file = "The file is empty.";
  else if (state.file.size > MAX_UPLOAD_BYTES) errors.file = "The file is larger than 512 MiB.";
  if (!/^[a-z0-9][a-z0-9_]*$/.test(state.source) || state.source.length > 128)
    errors.source =
      "Use up to 128 lowercase letters, digits and underscores, starting with a letter or digit.";
  if (!isCalendarDate(state.added)) errors.added = "Enter the date the data was added (YYYY-MM-DD).";
  if (state.mask_names !== "yes" && state.mask_names !== "no")
    errors.mask_names = "Choose whether personal names should be masked.";
  if (!state.declaration) errors.declaration = "Accept the declaration to continue.";
  if (Object.keys(errors).length || !format) return { errors };
  const parameters: UploadForm["parameters"] = { source: state.source, added: state.added };
  for (const key of ["license", "author", "source_ref"] as const) {
    const value = state[key].trim();
    if (value) parameters[key] = value;
  }
  parameters.per_record_provenance = state.per_record_provenance;
  parameters.mask_names = state.mask_names === "yes";
  return { errors, form: { format, parameters, declaration: { accepted: true, version: DECLARATION_VERSION } } };
}
