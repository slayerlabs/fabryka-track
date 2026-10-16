import assert from "node:assert/strict";
import test from "node:test";
import { parameterRefusal, withoutField } from "../frontend/src/uploads/refusal.ts";

const refused = (code, field, statusCode = 422, message = "Server words.") =>
  Object.assign(new Error(message), { statusCode, code, ...(field ? { field } : {}) });

test("a refused source address is shown at the address", () => {
  assert.deepEqual(parameterRefusal(refused("invalid_source_ref", "source_ref")), {
    errors: { source_ref: "The address must be a public address with a host, without a password or signed access key." },
    message: "Server words.",
  });
});

test("a one-line field refused for Markdown is shown at that field", () => {
  for (const field of ["pretty_name", "description", "publisher"])
    assert.equal(parameterRefusal(refused("invalid_parameters", field)).errors[field], "Use one line without Markdown headings.");
  assert.match(parameterRefusal(refused("invalid_parameters", "limitations")).errors.limitations, /headings/);
});

test("a refusal without a field, or naming a field the form does not show, is a banner only", () => {
  assert.deepEqual(parameterRefusal(refused("invalid_request", undefined)), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(refused("invalid_parameters", "source_ref_template")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(refused("invalid_parameters", "file")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(refused("invalid_parameters", "__proto__")), { errors: {}, message: "Server words." });
  assert.deepEqual(parameterRefusal(refused("invalid_parameters", "toString")), { errors: {}, message: "Server words." });
});

test("other failures are not parameter refusals", () => {
  assert.equal(parameterRefusal(refused("user_limit_reached", undefined, 429)), null);
  assert.equal(parameterRefusal(refused("file_too_large", undefined)), null);
  assert.equal(parameterRefusal(new TypeError("Failed to fetch")), null);
});

test("editing a refused field clears its error; the banner goes with the last one", () => {
  const refusal = { errors: { source_ref: "a", pretty_name: "b" }, message: "m" };
  assert.deepEqual(withoutField(refusal, "source_ref"), { errors: { pretty_name: "b" }, message: "m" });
  assert.equal(withoutField({ errors: { source_ref: "a" }, message: "m" }, "source_ref"), null);
  assert.equal(withoutField(refusal, "license"), refusal);
  assert.equal(withoutField(null, "license"), null);
  const bannerOnly = { errors: {}, message: "m" };
  assert.equal(withoutField(bannerOnly, "license"), bannerOnly);
});
