import assert from "node:assert/strict";
import test from "node:test";
import { loadUploadResults, summarize } from "../frontend/src/uploads/results.ts";
import { CHECK_LABELS, PII_LABELS, REJECT_LABELS, STAGE_LABELS, STAT_LABELS } from "../frontend/src/uploads/copy.ts";
import { REJECT_REASONS } from "../frontend/src/uploads/rejection.ts";

const BINDING = ["schema", "record", "token_count", "record_balance", "rejection_share", "exact_duplicate", "near_duplicate", "residual_pii", "empty_result", "metadata_conflict", "attribution_coverage"];
const ADVISORY = ["masking_only_duplicate", "license_needs_legal_review"];
const STATS = ["rows", "token_count", "exact_duplicate_pairs", "near_duplicate_pairs", "masking_only_duplicate_pairs", "residual_pii_records", "license_review_records"];

const checks = () => [
  ...BINDING.map((name) => ({ name, binding: true, status: "passed", count: 0 })),
  ...ADVISORY.map((name) => ({ name, binding: false, status: "passed", count: 0 })),
];

const payload = () => ({
  verdict: "passed", failure_code: null,
  report: {
    rows_in: 100, rows_out: 80,
    counters: { elapsed_ms: 1000 },
    qa: { checks: checks(), stats: { rows: 80, token_count: 5000 } },
    report: {
      funnel: { rows_in: 100, rejected: { empty_text: 6, duplicate_id: 4 }, removed: { masked_exact_dedup: 1, quality_labels: 3, upload_dedup: 6 }, rows_out: 80 },
      pii_masked: { phone: 2, pii: 3, person: 4, records: 5 },
    },
  },
});

test("cards show verdict, rows in and out, binding checks passed of total and tokens", () => {
  const { cards } = summarize(payload());
  assert.deepEqual(cards, { verdict: "passed", failureCode: null, rowsIn: 100, rowsOut: 80, checksPassed: 11, checksTotal: 11, tokens: 5000 });
});

test("only binding checks count toward the passed-of-total card", () => {
  const report = payload();
  report.report.qa.checks[0].status = "failed";
  report.report.qa.checks[0].count = 2;
  report.report.qa.checks[11].status = "failed";
  report.verdict = "failed_qa";
  report.failure_code = "qa_failed";
  const { cards } = summarize(report);
  assert.equal(cards.checksPassed, 10);
  assert.equal(cards.checksTotal, 11);
  assert.equal(cards.verdict, "failed_qa");
  assert.equal(cards.failureCode, "qa_failed");
});

test("the funnel follows pipeline order and carries the rejection reasons", () => {
  const { funnel } = summarize(payload());
  assert.deepEqual(funnel.stages.map((stage) => stage.key), ["intake", "quality_labels", "upload_dedup", "masked_exact_dedup"]);
  assert.deepEqual(funnel.stages.map((stage) => stage.removed), [10, 3, 6, 1]);
  assert.deepEqual(funnel.stages.map((stage) => stage.remaining), [90, 87, 81, 80]);
  assert.deepEqual(funnel.stages[0].reasons, [
    { reason: "duplicate_id", label: REJECT_LABELS.duplicate_id, count: 4 },
    { reason: "empty_text", label: REJECT_LABELS.empty_text, count: 6 },
  ]);
  assert.equal(funnel.rowsIn, 100);
  assert.equal(funnel.rowsOut, 80);
});

test("the 13 checks keep a fixed order with their status", () => {
  const report = payload();
  report.report.qa.checks.reverse();
  report.report.qa.checks[12] = { name: "schema", binding: true, status: "not_evaluated", count: null };
  const { checks: rows } = summarize(report);
  assert.deepEqual(rows.map((row) => row.name), [...BINDING, ...ADVISORY]);
  assert.deepEqual(rows[0], { name: "schema", label: CHECK_LABELS.schema, binding: true, status: "not_evaluated", count: null });
  assert.equal(rows.length, 13);
});

test("masks list phone, pii and person next to the record count", () => {
  assert.deepEqual(summarize(payload()).pii, { phone: 2, pii: 3, person: 4, records: 5 });
});

test("a report without funnel, without pii_masked or with null qa still renders cards", () => {
  const old = payload();
  delete old.report.report.funnel;
  delete old.report.report.pii_masked;
  const a = summarize(old);
  assert.equal(a.funnel, null);
  assert.equal(a.pii, null);
  assert.equal(a.cards.rowsIn, 100);
  assert.equal(a.cards.rowsOut, 80);

  const noQa = payload();
  noQa.report.qa = null;
  const b = summarize(noQa);
  assert.equal(b.checks, null);
  assert.deepEqual([b.cards.checksPassed, b.cards.checksTotal, b.cards.tokens], [null, null, null]);
  assert.notEqual(b.funnel, null);

  const bare = summarize({ verdict: "passed" });
  assert.deepEqual(bare.cards, { verdict: "passed", failureCode: null, rowsIn: null, rowsOut: null, checksPassed: null, checksTotal: null, tokens: null });
  assert.equal(bare.funnel, null);
  assert.equal(bare.checks, null);
  assert.equal(bare.pii, null);
});

test("no report at all gives empty cards and no sections", () => {
  const empty = summarize(null);
  assert.equal(empty.cards.verdict, null);
  assert.deepEqual([empty.funnel, empty.checks, empty.pii], [null, null, null]);
});

test("a funnel with a missing stage counts it as nothing removed and unknown names are kept", () => {
  const report = payload();
  report.report.report.funnel.removed = { upload_dedup: 2, brand_new_stage: 1 };
  report.report.report.funnel.rejected = { brand_new_reason: 3 };
  const { funnel } = summarize(report);
  assert.deepEqual(funnel.stages.map((stage) => stage.key), ["intake", "quality_labels", "upload_dedup", "masked_exact_dedup", "brand_new_stage"]);
  assert.equal(funnel.stages[1].removed, 0);
  assert.equal(funnel.stages[0].reasons[0].label, "brand_new_reason");
});

test("label maps cover every current reason, check, stat, stage and mask", () => {
  for (const reason of REJECT_REASONS) assert.ok(REJECT_LABELS[reason], reason);
  for (const name of [...BINDING, ...ADVISORY]) assert.ok(CHECK_LABELS[name], name);
  for (const name of STATS) assert.ok(STAT_LABELS[name], name);
  for (const name of ["quality_labels", "upload_dedup", "masked_exact_dedup"]) assert.ok(STAGE_LABELS[name], name);
  for (const name of ["phone", "pii", "person"]) assert.ok(PII_LABELS[name], name);
});

const job = (extra = {}) => ({ job_id: "a", pipeline: "p", client_phase: "complete", publication_state: "none", ...extra });

test("a job without a published report is returned without asking for the report", async () => {
  for (const extra of [{ processing_state: "cancelled" }, { client_phase: "rejected", processing_state: "rejected" }, { client_phase: "expired", publication_state: "published" }]) {
    const current = job(extra);
    const result = await loadUploadResults("a", {
      getUpload: async () => current,
      getReport: async () => { throw new Error("unexpected report request"); },
    });
    assert.deepEqual(result, { job: current, report: null, reportError: "" });
  }
});

test("a published job loads its report after the status, passing the signal on", async () => {
  const controller = new AbortController();
  const current = job({ processing_state: "passed", publication_state: "published" });
  const report = { verdict: "passed" };
  const events = [];
  const result = await loadUploadResults("a", {
    getUpload: async (id, signal) => { events.push("status"); assert.equal(signal, controller.signal); return current; },
    getReport: async (id, signal) => { events.push("report"); assert.equal(signal, controller.signal); return report; },
  }, controller.signal);
  assert.deepEqual(events, ["status", "report"]);
  assert.equal(result.report, report);
});

test("a report failure keeps the status and exposes the message", async () => {
  const current = job({ processing_state: "passed", publication_state: "published" });
  const result = await loadUploadResults("a", {
    getUpload: async () => current,
    getReport: async () => { throw new Error("Report unavailable"); },
  });
  assert.deepEqual(result, { job: current, report: null, reportError: "Report unavailable" });
});

test("an abort is rethrown rather than reported", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadUploadResults("a", { getUpload: async () => job(), getReport: async () => ({}) }, controller.signal));
});
