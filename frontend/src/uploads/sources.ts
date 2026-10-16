import type { SourceDescription, SourceSummary } from "./api.ts";
import { knownDomains, type UploadFormState } from "./form.ts";

const SUGGESTIONS = 8;
const DESCRIBED = ["source_ref", "pretty_name", "description", "publisher", "limitations"] as const;

export function suggestSources(list: SourceSummary[], query: string): SourceSummary[] {
  const typed = query.trim().toLowerCase();
  const starts = list.filter(({ source }) => source.startsWith(typed));
  const contains = list.filter(({ source }) => !source.startsWith(typed) && source.includes(typed));
  return [...starts, ...contains].slice(0, SUGGESTIONS);
}

export const findSource = (list: SourceSummary[], name: string) => list.find(({ source }) => source === name) ?? null;

export function sourceKind(list: SourceSummary[], name: string): "none" | "new" | "existing" {
  if (!name.trim()) return "none";
  return findSource(list, name) ? "existing" : "new";
}

export function applySourceDescription(form: UploadFormState, described: SourceDescription, force: boolean): UploadFormState {
  if (described.source !== form.source) return form;
  const next = { ...form };
  for (const key of DESCRIBED) {
    if (force || !form[key].trim()) next[key] = described.description[key] ?? "";
  }
  const domains = knownDomains(described.description.domains ?? []);
  if (force || form.domains.length === 0) next.domains = domains;
  return next;
}

export function versionBanner({ source, version, uploader }: SourceDescription) {
  return {
    title: `New version of source ${source} (currently v${version}${uploader ? `, uploaded by ${uploader}` : ""}).`,
    body: `It replaces the previous version entirely for everyone. The fields below are filled in from v${version}; change anything that is different now.`,
  };
}

export const filledFrom = ({ version, description }: SourceDescription) =>
  `Filled in from v${version} · ${description.pretty_name}`;

export type PickEvent =
  | { kind: "picked"; source: string; loaded: boolean }
  | { kind: "source"; source: string }
  | { kind: "settled"; source: string };

// a pick forces the description only for the fetch it started; any other name or outcome drops it
export function nextPick(picked: string, event: PickEvent): string {
  if (event.kind === "picked") return event.loaded ? "" : event.source;
  if (event.kind === "source") return event.source === picked ? picked : "";
  return event.source === picked ? "" : picked;
}
