import { formatBytes } from "./bytes.ts";

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const pipelineLimit = (pipeline?: { max_encoded_bytes?: unknown }) => {
  const limit = pipeline?.max_encoded_bytes;
  return typeof limit === "number" && limit > 0 ? limit : MAX_UPLOAD_BYTES;
};
export const DECLARATION_VERSION = "upload-declaration-v0-placeholder";
export const DECLARATION_TEXT =
  "I confirm that I have the right to share this data for processing and publication, and that the license I give is truthful.";

export const DOMAINS = ["Books", "Conversation", "Dialect", "Encyclopedic", "Legal", "Medical", "News", "Other",
  "Readaloud", "Social Media", "Speeches", "Spoken", "Subtitles", "Web"] as const;
const SOURCE_REF = /^(https?|doi|hdl|urn|ark|oai):\S+$/;

export const knownDomains = (values: readonly unknown[]): string[] => DOMAINS.filter((domain) => values.includes(domain));

export const toggleDomain = (current: string[], domain: string): string[] =>
  DOMAINS.filter((known) => (known === domain ? !current.includes(known) : current.includes(known)));

// the server strips and splits with Python's str.strip and str.splitlines, which differ from trim and \n
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const pyStrip = (value: string) => value.replace(PY_EDGE_SPACE, "");
const codePoints = (value: string) => [...value].length;

const isHeadingMarker = (line: string) => {
  const stripped = pyStrip(line);
  return stripped.startsWith("#") || /^=+$/.test(stripped) || /^-+$/.test(stripped);
};

function checkedText(raw: string, limit: number, oneLine: boolean, required: string | null) {
  const text = pyStrip(raw);
  if (!text) return { text, error: required ?? undefined };
  if (codePoints(text) > limit) return { text, error: `Use at most ${limit.toLocaleString("en-US")} characters.` };
  const lines = text.split(PY_LINE_BREAK);
  if (oneLine && lines.length > 1) return { text, error: "Use a single line." };
  if (["<!--", "-->", "---"].some((marker) => text.includes(marker)) || lines.some(isHeadingMarker))
    return { text, error: "Do not start a line with # or use ---, <!-- or -->." };
  return { text, error: undefined };
}

export interface UploadForm {
  pipeline: string;
  format: "jsonl" | "parquet";
  parameters: Record<string, string | boolean | string[]>;
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
  pretty_name: string;
  description: string;
  publisher: string;
  limitations: string;
  domains: string[];
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
  const sourceRef = state.source_ref.trim();
  if (!sourceRef) errors.source_ref = "Enter the address of the source.";
  else if (!SOURCE_REF.test(sourceRef) || sourceRef.length > 4096)
    errors.source_ref = "Use an address that starts with https:, http:, doi:, hdl:, urn:, ark: or oai:, without spaces.";
  const prettyName = checkedText(state.pretty_name, 200, true, "Enter the name of the source.");
  if (prettyName.error) errors.pretty_name = prettyName.error;
  const description = checkedText(state.description, 1000, true, "Describe the data in one to three sentences.");
  if (description.error) errors.description = description.error;
  const publisher = checkedText(state.publisher, 200, true, null);
  if (publisher.error) errors.publisher = publisher.error;
  const limitations = checkedText(state.limitations, 5000, false, null);
  if (limitations.error) errors.limitations = limitations.error;
  const domains = knownDomains(state.domains);
  if (!domains.length || domains.length !== state.domains.length) errors.domains = "Choose one or more domains.";
  if (!state.declaration) errors.declaration = "Accept the declaration to continue.";
  if (Object.keys(errors).length || !format) return { errors };
  const parameters: UploadForm["parameters"] = {
    source: state.source,
    added: state.added,
    source_ref: sourceRef,
    pretty_name: prettyName.text,
    description: description.text,
    domains,
  };
  const license = state.license.trim();
  if (license) parameters.license = license;
  const author = state.author.trim();
  if (author) parameters.author = author;
  if (publisher.text) parameters.publisher = publisher.text;
  if (limitations.text) parameters.limitations = limitations.text;
  parameters.per_record_provenance = state.per_record_provenance;
  parameters.mask_names = true;
  return { errors, form: { pipeline: state.pipeline, format, parameters, declaration: { accepted: true, version: DECLARATION_VERSION } } };
}

const PREFILLED_TEXT = ["source", "added", "license", "author", "source_ref", "pretty_name", "description", "publisher", "limitations"] as const;

export function prefillForm(form: UploadFormState, parameters: unknown, fresh: UploadFormState): UploadFormState {
  if (!parameters || typeof parameters !== "object") return form;
  const stored = parameters as Record<string, unknown>;
  const next = { ...form };
  for (const key of PREFILLED_TEXT) {
    const value = stored[key];
    if (typeof value === "string" && form[key] === fresh[key]) next[key] = value;
  }
  if (Array.isArray(stored.domains) && form.domains.length === 0) next.domains = knownDomains(stored.domains);
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
