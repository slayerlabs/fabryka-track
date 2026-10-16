import assert from "node:assert/strict";
import test from "node:test";
import { parameterRefusal, refusalSummary, withoutField } from "../frontend/src/uploads/refusal.ts";
import { uploadFile } from "../frontend/src/uploads/uploader.ts";

const rejection = (code, field, statusCode = 422, message = "Server words.") =>
  Object.assign(new Error(message), { statusCode, code, ...(field ? { field } : {}) });

async function failUpload(failAt, error = rejection("invalid_request", undefined)) {
  const file = { name: "a.jsonl", size: 4, slice: () => new Blob(["abcd"]) };
  const form = { pipeline: "p", format: "jsonl", parameters: {}, declaration: {} };
  let n = 0;
  const deps = {
    call: async (path) => {
      n++;
      if (path === "/api/uploads") {
        if (failAt === "create") throw error;
        return { job_id: "j1" };
      }
      if (path.endsWith("/parts")) return { method: "PUT", url: "https://x.test/p" };
      if (path.endsWith("/cancel")) return {};
      if (path.endsWith("/confirm")) throw error;
      return { transfer_state: "ready" };
    },
    fetch: async () => new Response("", { headers: { ETag: "e" } }),
    sleep: async () => {},
    hash: async () => "h",
    newKey: () => "k",
  };
  try {
    await uploadFile(file, form, deps);
  } catch (e) {
    return e;
  }
  throw new Error("expected failure");
}

const refused = (code, field, statusCode, message) => failUpload("create", rejection(code, field, statusCode, message));

test("a refused source address is shown at the address", async () => {
  assert.deepEqual(parameterRefusal(await refused("invalid_source_ref", "source_ref")), {
    errors: { source_ref: "The address must be a public address with a host, without a password or signed access key." },
    message: "Server words.",
  });
});

test("a one-line field refused for Markdown is shown at that field", async () => {
  for (const field of ["pretty_name", "description", "publisher"])
    assert.equal(parameterRefusal(await refused("invalid_parameters", field)).errors[field], "Use one line without Markdown headings.");
  assert.match(parameterRefusal(await refused("invalid_parameters", "limitations")).errors.limitations, /headings/);
});

test("a refusal without a field, or naming a field the form does not show, is a banner only", async () => {
  assert.deepEqual(parameterRefusal(await refused("invalid_request", undefined)), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(await refused("invalid_parameters", "source_ref_template")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(await refused("invalid_parameters", "file")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(await refused("invalid_parameters", "__proto__")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(await refused("invalid_parameters", "toString")), { errors: {}, message: "Server words." });
});

test("a refusal from a call after the job was created is not a parameter refusal", async () => {
  assert.equal(parameterRefusal(await failUpload("confirm")), null);
});

test("other failures are not parameter refusals", async () => {
  assert.equal(parameterRefusal(await refused("user_limit_reached", undefined, 429)), null);
  assert.equal(parameterRefusal(await refused("file_too_large", undefined)), null);
  assert.equal(parameterRefusal(new TypeError("Failed to fetch")), null);
});

test("editing a refused field clears its error; the banner goes with the last one", async () => {
  const refusal = { errors: { source_ref: "a", pretty_name: "b" }, message: "m" };
  assert.deepEqual(withoutField(refusal, "source_ref"), { errors: { pretty_name: "b" }, message: "m" });
  assert.equal(withoutField({ errors: { source_ref: "a" }, message: "m" }, "source_ref"), null);
  assert.equal(withoutField(refusal, "license"), refusal);
  assert.equal(withoutField(null, "license"), null);
  const bannerOnly = { errors: {}, message: "m" };
  assert.equal(withoutField(bannerOnly, "license"), bannerOnly);
});

test("a banner-only refusal does not point at a highlighted field", () => {
  const text = refusalSummary({ errors: {}, message: "One of the details you entered cannot be used." });
  assert.doesNotMatch(text, /highlighted/);
  assert.match(text, /^One of the details you entered cannot be used\. Fix the details below and run again\. Nothing was uploaded\.$/);
  assert.match(refusalSummary({ errors: { license: "x" }, message: "m" }), /Fix the highlighted fields/);
});
