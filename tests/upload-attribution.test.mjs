import assert from "node:assert/strict";
import test from "node:test";
import { hasAttribution, resultGrant } from "../frontend/src/uploads/api.ts";

test("only a published attribution enables its download", () => {
  for (const publication_state of ["none", "pending", "expired", "published"]) {
    assert.equal(hasAttribution({ publication_state }), false);
    assert.equal(hasAttribution({ publication_state, artifacts: [{kind: "result"}] }), false);
    assert.equal(hasAttribution({ publication_state, artifacts: [{kind: "attribution"}] }), publication_state === "published");
  }
});

test("result grant keeps legacy URL and forwards attribution with diagnostic", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options.credentials]);
    return new Response(JSON.stringify({url: "https://storage.invalid/object"}));
  });
  await resultGrant("job-a", false);
  await resultGrant("job-a", true, "attribution");
  assert.deepEqual(calls, [["/api/uploads/job-a/result", "same-origin"], ["/api/uploads/job-a/result?diagnostic=true&kind=attribution", "same-origin"]]);
});
