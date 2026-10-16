import { useEffect, useState } from "react";
import { getSource, listSources, type SourceDescription, type SourceSummary } from "./api";

export function useSourceList(): SourceSummary[] {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    // without suggestions every name reads as a new source, which the controller still accepts
    listSources(controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) setSources(reply.sources ?? []);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);
  return sources;
}

export function useSourceDescription(name: string, listed: boolean, onFailed?: (name: string) => void): SourceDescription | null {
  const [described, setDescribed] = useState<SourceDescription | null>(null);
  useEffect(() => {
    setDescribed(null);
    if (!listed) return;
    const controller = new AbortController();
    getSource(name, controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) setDescribed(reply);
      },
      () => {
        if (!controller.signal.aborted) onFailed?.(name);
      },
    );
    return () => controller.abort();
  }, [name, listed]);
  return described;
}
