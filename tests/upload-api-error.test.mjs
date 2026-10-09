import assert from "node:assert/strict";
import test from "node:test";
import { apiError } from "../frontend/src/provider.ts";

test("api errors expose a numeric status and a string code only", () => {
  assert.deepEqual(apiError(Object.assign(new Error("x"), { statusCode: 429, code: "user_limit_reached" })),
    { status: 429, code: "user_limit_reached" });
  assert.deepEqual(apiError(new TypeError("Failed to fetch")), { status: undefined, code: undefined });
  assert.deepEqual(apiError(new DOMException("aborted", "AbortError")), { status: undefined, code: undefined });
  assert.deepEqual(apiError(null), { status: undefined, code: undefined });
});
