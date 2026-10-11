import assert from "node:assert/strict";
import test from "node:test";
import { piiBars, waterfallBars } from "../frontend/src/uploads/charts.ts";
import { summarize } from "../frontend/src/uploads/results.ts";

const report = (funnel, pii_masked) => ({ verdict: "passed", report: { report: { funnel, pii_masked } } });
const FUNNEL = { rows_in: 1000, rejected: { missing_id: 10, empty_text: 40 }, removed: { quality_labels: 100, upload_dedup: 50, masked_exact_dedup: 0 }, rows_out: 800 };

test("the waterfall starts at the input, steps down by each removal and ends at the output", () => {
  const bars = waterfallBars(summarize(report(FUNNEL)).funnel);
  assert.deepEqual(bars.map((bar) => [bar.label, bar.base, bar.value, bar.kind]), [
    ["Records in", 0, 1000, "total"],
    ["Rejected: missing id", 990, 10, "removed"],
    ["Rejected: empty text", 950, 40, "removed"],
    ["Too short", 850, 100, "removed"],
    ["Near or exact duplicates", 800, 50, "removed"],
    ["Duplicates after masking", 800, 0, "removed"],
    ["Records out", 0, 800, "total"],
  ]);
});

test("every removal floats on the remaining records so the bars add up", () => {
  const bars = waterfallBars(summarize(report(FUNNEL)).funnel);
  const removed = bars.filter((bar) => bar.kind === "removed");
  assert.equal(1000 - removed.reduce((sum, bar) => sum + bar.value, 0), bars.at(-1).value);
});

test("intake without reasons still shows one rejection bar, and a missing output falls back to what remains", () => {
  const bars = waterfallBars(summarize(report({ rows_in: 10, removed: { quality_labels: 2 } })).funnel);
  assert.deepEqual(bars.map((bar) => bar.label).slice(0, 2), ["Records in", "Rejected at intake"]);
  assert.equal(bars.at(-1).value, 8);
});

test("no funnel means no waterfall", () => {
  assert.deepEqual(waterfallBars(null), []);
});

test("personal data bars use the report labels and skip an absent section", () => {
  assert.deepEqual(piiBars(summarize(report(undefined, { phone: 3, pii: 0, person: 5, records: 6 })).pii), [
    { label: "Phone numbers", value: 3 },
    { label: "Other personal data (PESEL, email…)", value: 0 },
    { label: "Person names", value: 5 },
    { label: "Records with a mask", value: 6 },
  ]);
  assert.deepEqual(piiBars(null), []);
});

test("when nothing was masked there are no bars to draw", () => {
  assert.deepEqual(piiBars(summarize(report(undefined, { phone: 0, pii: 0, person: 0, records: 0 })).pii), []);
});
