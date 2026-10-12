import { useEffect, useState } from "react";
import { errorMessage } from "./display";
import { fileKey } from "./gate";
import { precheckFile, type PrecheckReport } from "./precheck";

export type FileCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "done"; key: string; report: PrecheckReport };

export function useFileCheck(file: File | null, limitBytes: number): FileCheck {
  const [check, setCheck] = useState<FileCheck>({ status: "idle" });
  useEffect(() => {
    if (!file) {
      setCheck({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setCheck({ status: "checking" });
    precheckFile(file, limitBytes, controller.signal).then(
      (report) => {
        if (!controller.signal.aborted) setCheck({ status: "done", key: fileKey(file), report });
      },
      (error) => {
        if (!controller.signal.aborted) setCheck({ status: "error", message: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [file, limitBytes]);
  return check;
}
