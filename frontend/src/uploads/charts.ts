import { COPY } from "./copy.ts";
import type { Funnel, Pii } from "./results.ts";

export interface WaterfallBar {
  label: string;
  base: number;
  value: number;
  kind: "total" | "removed";
}

export function waterfallBars(funnel: Funnel | null): WaterfallBar[] {
  if (!funnel) return [];
  const bars: WaterfallBar[] = [{ label: COPY.charts.recordsIn, base: 0, value: funnel.rowsIn, kind: "total" }];
  let remaining = funnel.rowsIn;
  const remove = (label: string, value: number) => {
    remaining -= value;
    bars.push({ label, base: remaining, value, kind: "removed" });
  };
  for (const stage of funnel.stages) {
    if (stage.key === "intake" && stage.reasons.length === 0) remove(COPY.charts.rejectedAtIntake, stage.removed);
    else if (stage.key === "intake") for (const reason of stage.reasons) remove(`${COPY.charts.rejectedPrefix}${reason.label}`, reason.count);
    else remove(stage.label, stage.removed);
  }
  bars.push({ label: COPY.charts.recordsOut, base: 0, value: funnel.rowsOut ?? remaining, kind: "total" });
  return bars;
}

export function piiBars(pii: Pii | null) {
  if (!pii) return [];
  return [
    { label: COPY.labels.pii.phone, value: pii.phone },
    { label: COPY.labels.pii.pii, value: pii.pii },
    { label: COPY.labels.pii.person, value: pii.person },
    { label: COPY.charts.recordsWithMask, value: pii.records },
  ];
}
