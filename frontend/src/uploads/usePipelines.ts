import { useEffect, useState } from "react";
import { listPipelines, type UploadPipeline } from "./api";
import { errorMessage } from "./display";

export interface Pipelines {
  list: UploadPipeline[];
  loaded: boolean;
  error: string;
}

export function usePipelines(): Pipelines {
  const [value, setValue] = useState<Pipelines>({ list: [], loaded: false, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    listPipelines(controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) setValue({ list: reply.pipelines ?? [], loaded: true, error: "" });
      },
      (e) => {
        if (!controller.signal.aborted) setValue({ list: [], loaded: true, error: errorMessage(e) });
      },
    );
    return () => controller.abort();
  }, []);
  return value;
}
