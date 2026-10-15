import { formatBytes } from "./bytes.ts";

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const pipelineLimit = (pipeline?: { max_encoded_bytes?: unknown }) => {
  const limit = pipeline?.max_encoded_bytes;
  return typeof limit === "number" && limit > 0 ? limit : MAX_UPLOAD_BYTES;
};
export const DECLARATION_VERSION = "upload-declaration-v0-placeholder";
export const DECLARATION_TEXT =
  "I confirm that I have the right to share this data for processing and publication, and that the license I give is truthful.";

export interface UploadForm {
  pipeline: string;
  format: "jsonl" | "parquet";
  parameters: Record<string, string | boolean>;
  declaration: { accepted: true; version: string };
}

export interface UploadFormState {
  pipeline: string;
  file: File | null;
  source: string;
  added: string;
  license: string;
  author: string;
  source_ref: string;
  per_record_provenance: boolean;
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

export function validateUpload(state: UploadFormState, limitBytes = MAX_UPLOAD_BYTES): { errors: UploadErrors; form?: UploadForm } {
  const errors: UploadErrors = {};
  const format = state.file ? formatFor(state.file.name) : null;
  if (!state.pipeline) errors.pipeline = "Choose a mode.";
  if (!state.file) errors.file = "Choose a file to upload.";
  else if (!format) errors.file = "Choose a .jsonl or .parquet file.";
  else if (state.file.size === 0) errors.file = "The file is empty.";
  else if (state.file.size > limitBytes) errors.file = `The file is larger than ${formatBytes(limitBytes)}.`;
  if (!/^[a-z0-9][a-z0-9_]*$/.test(state.source) || state.source.length > 128)
    errors.source =
      "Use up to 128 lowercase letters, digits and underscores, starting with a letter or digit.";
  if (!isCalendarDate(state.added)) errors.added = "Enter the date the data was added (YYYY-MM-DD).";
  if (!state.license.trim()) errors.license = "Enter the license of the data, for example CC-BY-4.0.";
  if (!state.declaration) errors.declaration = "Accept the declaration to continue.";
  if (Object.keys(errors).length || !format) return { errors };
  const parameters: UploadForm["parameters"] = { source: state.source, added: state.added };
  for (const key of ["license", "author", "source_ref"] as const) {
    const value = state[key].trim();
    if (value) parameters[key] = value;
  }
  parameters.per_record_provenance = state.per_record_provenance;
  parameters.mask_names = true;
  return { errors, form: { pipeline: state.pipeline, format, parameters, declaration: { accepted: true, version: DECLARATION_VERSION } } };
}

const PREFILLED_TEXT = ["source", "added", "license", "author", "source_ref"] as const;

export function prefillForm(form: UploadFormState, parameters: unknown, fresh: UploadFormState): UploadFormState {
  if (!parameters || typeof parameters !== "object") return form;
  const stored = parameters as Record<string, unknown>;
  const next = { ...form };
  for (const key of PREFILLED_TEXT) {
    const value = stored[key];
    if (typeof value === "string" && form[key] === fresh[key]) next[key] = value;
  }
  const provenance = stored.per_record_provenance;
  if (typeof provenance === "boolean" && form.per_record_provenance === fresh.per_record_provenance)
    next.per_record_provenance = provenance;
  return next;
}

// the browser cannot refill a file input, and the declaration is given again for the new file
export function carryForm(form: UploadFormState, fresh: UploadFormState, next: { pipeline: string; job: string }, jobParameters?: unknown) {
  if (!next.job && !next.pipeline) return fresh;
  const carried = { ...form, file: null, declaration: false };
  return next.job ? carried : prefillForm(carried, jobParameters, fresh);
}
