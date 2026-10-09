import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeReport, checksOpen } from "../frontend/src/uploads/report.ts";

const OLD = {
  verdict: "passed", failure_code: null,
  report: {
    rows_in: 212, rows_out: 212,
    counters: { elapsed_ms: 328907, input_bytes: 9961530, output_bytes: 3719320, rss_bytes: 1 },
    qa: { checks: [{ name: "schema", binding: true, status: "passed", count: 0 }],
          stats: { rows: 212, token_count: 3503190, exact_duplicate_pairs: 0, near_duplicate_pairs: 2,
                   masking_only_duplicate_pairs: 0, residual_pii_records: 0, license_review_records: 0 } },
    report: { pii_detected: ["PESEL", "email", "phone"], pii_unmeasured: ["PERSON", "street_address"] },
  },
};
const NEW = structuredClone(OLD);
NEW.report.report.funnel = { rows_in: 5, rejected: { empty_text: 1 }, removed: { quality_labels: 0, upload_dedup: 1, masked_exact_dedup: 0 }, rows_out: 3 };
NEW.report.report.pii_masked = { phone: 0, pii: 2, person: 0, records: 1 };

const titles = (r) => summarizeReport(r).map((s) => s.title);
const rows = (r, t) => summarizeReport(r).find((s) => s.title === t)?.rows ?? [];
const row = (r, t, label) => rows(r, t).find((x) => x.label === label)?.value;

test("an old report shows what it has and no funnel or masks", () => {
  assert.deepEqual(titles(OLD), ["What happened to the data", "Processing"]);
  assert.equal(row(OLD, "What happened to the data", "Tokens"), "3,503,190");
  assert.equal(row(OLD, "What happened to the data", "Near-duplicate pairs"), "2");
  assert.equal(row(OLD, "What happened to the data", "Not measured"), "PERSON, street_address");
  assert.equal(row(OLD, "Processing", "Processing time"), "5m 28s");
  assert.equal(row(OLD, "Processing", "Input size"), "9.5 MB");
  assert.equal(row(OLD, "Processing", "Output size"), "3.5 MB");
});

test("seeds, digests and memory are never shown", () => {
  const text = JSON.stringify(summarizeReport(NEW));
  assert.doesNotMatch(text, /rss|seed|digest/i);
});

test("a report with nothing in it has no sections", () => {
  assert.deepEqual(summarizeReport({ verdict: "passed", report: {} }), []);
  assert.deepEqual(summarizeReport({ verdict: "passed" }), []);
});

test("a new report shows the funnel and the masks", () => {
  assert.deepEqual(titles(NEW), ["Records", "What happened to the data", "Personal data masked", "Processing"]);
  assert.deepEqual(rows(NEW, "Records").map((r) => r.label), ["Records in", "Rejected: empty text", "Removed: too short", "Removed: near or exact duplicates", "Removed: duplicates after masking", "Records out"]);
  assert.equal(row(NEW, "Records", "Removed: too short"), "0");
  assert.equal(row(NEW, "Personal data masked", "Other personal data (PESEL, email…)"), "2");
  assert.equal(row(NEW, "Personal data masked", "Phone numbers"), "0");
  assert.equal(row(NEW, "Personal data masked", "Person names"), "0");
  assert.equal(row(NEW, "Personal data masked", "Records with a mask"), "1");
});

test("every rejection reason has a readable label", () => {
  const r = structuredClone(NEW);
  const reasons = ["unparseable", "not_an_object", "missing_id", "invalid_id", "duplicate_id", "invalid_text", "empty_text", "source_mismatch", "invalid_field_type", "invalid_date", "missing_license", "missing_source_ref"];
  r.report.report.funnel.rejected = Object.fromEntries(reasons.map((x) => [x, 1]));
  const labels = rows(r, "Records").map((x) => x.label).filter((l) => l.startsWith("Rejected: "));
  assert.equal(labels.length, 12);
  for (const l of labels) assert.doesNotMatch(l, /^Rejected: [a-z]+_[a-z_]+$/);
});

test("unknown names fall back to the raw name", () => {
  const r = structuredClone(NEW);
  r.report.report.funnel.rejected = { brand_new_reason: 1 };
  r.report.report.funnel.removed = { brand_new_stage: 4 };
  assert.ok(rows(r, "Records").some((x) => x.label === "Rejected: brand_new_reason"));
  assert.ok(rows(r, "Records").some((x) => x.label === "Removed: brand_new_stage" && x.value === "4"));
});

test("checks are open only when one failed", () => {
  assert.equal(checksOpen(OLD), false);
  const f = structuredClone(OLD); f.report.qa.checks[0].status = "failed";
  assert.equal(checksOpen(f), true);
});
