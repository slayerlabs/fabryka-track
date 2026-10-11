import assert from "node:assert/strict";
import test from "node:test";
import { loadUploadResults } from "../frontend/src/uploads/results.ts";

const job = (extra = {}) => ({
  job_id: "upload-a", pipeline: "clean", client_phase: "complete", publication_state: "none", ...extra,
});

for (const [name, extra] of [
  ["cancelled", { processing_state: "cancelled" }],
  ["rejected", { client_phase: "rejected", processing_state: "rejected" }],
  ["expired", { client_phase: "expired" }],
  ["expired published", { client_phase: "expired", publication_state: "published" }],
]) {
  test(`${name} preserves status without requesting a report`, async () => {
    const current = job(extra);
    const events = [];
    const result = await loadUploadResults(current.job_id, {
      getUpload: async (id) => { events.push(["status", id]); return current; },
      getReport: async () => { events.push(["report"]); throw new Error("Unexpected report request"); },
    });
    assert.equal(result.job, current);
    assert.equal(result.report, null);
    assert.equal(result.reportError, "");
    assert.deepEqual(events, [["status", current.job_id]]);
  });
}

for (const processing_state of ["passed", "failed_qa"]) {
  test(`published ${processing_state} loads the unchanged report after status`, async () => {
    const current = job({ processing_state, publication_state: "published" });
    const report = { verdict: processing_state, report: { rows_in: 23, rows_out: 17 } };
    const controller = new AbortController();
    const events = [];
    const result = await loadUploadResults(current.job_id, {
      getUpload: async (id, signal) => { events.push(["status", id]); assert.equal(signal, controller.signal); return current; },
      getReport: async (id, signal) => { events.push(["report", id]); assert.equal(signal, controller.signal); return report; },
    }, controller.signal);
    assert.equal(result.job, current);
    assert.equal(result.report, report);
    assert.equal(result.reportError, "");
    assert.deepEqual(events, [["status", current.job_id], ["report", current.job_id]]);
  });
}

for (const statusCode of [409, 410, 503]) {
  test(`report ${statusCode} preserves status and exposes the report error`, async () => {
    const current = job({ processing_state: "passed", publication_state: "published" });
    const error = Object.assign(new Error(`Report unavailable (${statusCode})`), { statusCode });
    const events = [];
    const result = await loadUploadResults(current.job_id, {
      getUpload: async () => { events.push("status"); return current; },
      getReport: async () => { events.push("report"); throw error; },
    });
    assert.equal(result.job, current);
    assert.equal(result.report, null);
    assert.equal(result.reportError, error.message);
    assert.deepEqual(events, ["status", "report"]);
  });
}

test("status 404 rejects without requesting a report", async () => {
  const error = Object.assign(new Error("Upload not found"), { statusCode: 404 });
  const events = [];
  await assert.rejects(loadUploadResults("missing", {
    getUpload: async () => { events.push("status"); throw error; },
    getReport: async () => { events.push("report"); return {}; },
  }), (received) => received === error);
  assert.deepEqual(events, ["status"]);
});

test("an already aborted load rejects before requesting status", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  await assert.rejects(loadUploadResults("upload-a", {
    getUpload: async () => { events.push("status"); return job(); },
    getReport: async () => { events.push("report"); return {}; },
  }, controller.signal), { name: "AbortError" });
  assert.deepEqual(events, []);
});

for (const rejects of [false, true]) {
  test(`abort during report ${rejects ? "rejection" : "resolution"} cannot return success`, async () => {
    const controller = new AbortController();
    const events = [];
    let finishReport;
    let reportStarted;
    const started = new Promise((resolve) => { reportStarted = resolve; });
    const pending = loadUploadResults("upload-a", {
      getUpload: async () => { events.push("status"); return job({ publication_state: "published" }); },
      getReport: async () => {
        events.push("report");
        reportStarted();
        return new Promise((resolve, reject) => { finishReport = rejects ? reject : resolve; });
      },
    }, controller.signal);
    await started;
    controller.abort();
    finishReport(rejects ? new Error("Report unavailable") : { verdict: "passed" });
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(events, ["status", "report"]);
  });
}

test("a report AbortError rejects even when the signal is not aborted", async () => {
  const events = [];
  await assert.rejects(loadUploadResults("upload-a", {
    getUpload: async () => { events.push("status"); return job({ publication_state: "published" }); },
    getReport: async () => { events.push("report"); throw new DOMException("Aborted", "AbortError"); },
  }), { name: "AbortError" });
  assert.deepEqual(events, ["status", "report"]);
});

test("abort after status skips the report", async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(loadUploadResults("upload-a", {
    getUpload: async () => { events.push("status"); controller.abort(); return job({ publication_state: "published" }); },
    getReport: async () => { events.push("report"); return {}; },
  }, controller.signal), { name: "AbortError" });
  assert.deepEqual(events, ["status"]);
});
