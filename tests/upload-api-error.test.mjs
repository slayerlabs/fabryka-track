import assert from "node:assert/strict";
import test from "node:test";
import { apiError, request } from "../frontend/src/provider.ts";

test("api errors expose a numeric status, a string code and a string field only", () => {
  assert.deepEqual(apiError(Object.assign(new Error("x"), { statusCode: 429, code: "user_limit_reached" })),
    { status: 429, code: "user_limit_reached", field: undefined });
  assert.deepEqual(apiError(Object.assign(new Error("x"), { statusCode: 422, code: "invalid_source_ref", field: "source_ref" })),
    { status: 422, code: "invalid_source_ref", field: "source_ref" });
  assert.deepEqual(apiError(Object.assign(new Error("x"), { statusCode: 422, field: 7 })),
    { status: 422, code: undefined, field: undefined });
  assert.deepEqual(apiError(new TypeError("Failed to fetch")), { status: undefined, code: undefined, field: undefined });
  assert.deepEqual(apiError(new DOMException("aborted", "AbortError")), { status: undefined, code: undefined, field: undefined });
  assert.deepEqual(apiError(null), { status: undefined, code: undefined, field: undefined });
});

test("a refused request keeps the field the server named", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ detail: "The source address cannot be used.", code: "invalid_source_ref", field: "source_ref" }), { status: 422 }));
  await assert.rejects(request("/api/uploads", { method: "POST", body: "{}" }), (error) => {
    assert.equal(error.message, "The source address cannot be used.");
    assert.deepEqual(apiError(error), { status: 422, code: "invalid_source_ref", field: "source_ref" });
    return true;
  });
});
