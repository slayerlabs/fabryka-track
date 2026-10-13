export type StudioMode = "beginner" | "advanced";

export function parseStudioMode(params: URLSearchParams): StudioMode | null {
  const mode = params.get("mode");
  return mode === "beginner" || mode === "advanced" ? mode : null;
}

export function resolveStudioMode(params: URLSearchParams, fork: boolean): StudioMode {
  return parseStudioMode(params) ?? (fork ? "advanced" : "beginner");
}

export function studioModeUrl(params: URLSearchParams, mode: StudioMode | null): string {
  const next = new URLSearchParams(params);
  if (mode) next.set("mode", mode);
  else next.delete("mode");
  const query = next.toString();
  return query ? `/new?${query}` : "/new";
}
