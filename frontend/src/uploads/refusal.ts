import { apiError } from "../provider.ts";
import type { UploadErrors } from "./form.ts";

export interface Refusal {
  errors: UploadErrors;
  message: string;
}

const ONE_LINE = "Use one line without Markdown headings.";
const PARAMETER_CODES = new Set(["invalid_source_ref", "invalid_parameters", "invalid_request"]);
const FIELD_MESSAGES: Record<string, Partial<Record<keyof UploadErrors, string>>> = {
  invalid_source_ref: {
    source_ref: "The address must be a public address with a host, without a password or signed access key.",
  },
  invalid_parameters: {
    source_ref: "Use an address that starts with https:, http:, doi:, hdl:, urn:, ark: or oai:, without spaces.",
    pretty_name: ONE_LINE,
    description: ONE_LINE,
    publisher: ONE_LINE,
    limitations: "Remove Markdown headings, lines of only dashes or equals signs, and comment markers.",
    domains: "Choose one or more domains from the list.",
    source: "Use up to 128 lowercase letters, digits and underscores, starting with a letter or digit.",
    added: "Enter the date the data was added (YYYY-MM-DD).",
    license: "Enter the license of the data, for example CC-BY-4.0.",
    author: "This author cannot be used. Check it and run again.",
  },
};
const FORM_FIELDS = new Set(["source", "added", "license", "author", "source_ref", "pretty_name", "description", "domains", "publisher", "limitations"]);

export function parameterRefusal(error: unknown): Refusal | null {
  const { status, code, field } = apiError(error);
  if (status !== 422 || !code || !PARAMETER_CODES.has(code)) return null;
  const message = error instanceof Error ? error.message : "";
  if (!field || !FORM_FIELDS.has(field)) return { errors: {}, message };
  const key = field as keyof UploadErrors;
  return { errors: { [key]: FIELD_MESSAGES[code]?.[key] ?? message }, message };
}

export function withoutField(refusal: Refusal | null, key: string): Refusal | null {
  if (!refusal || !Object.hasOwn(refusal.errors, key)) return refusal;
  const errors = { ...refusal.errors };
  delete errors[key as keyof UploadErrors];
  return Object.keys(errors).length ? { ...refusal, errors } : null;
}
