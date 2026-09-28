import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointDetails,
  filterRows,
  hfLink,
  rankRows,
  sizeBucket,
  sortRows,
} from "../frontend/src/pages/model-board-data.ts";
const row = (run_id, { en = {}, pl = {}, ...extras } = {}) => ({
  run_id,
  name: run_id,
  owner: "researcher",
  kind: "track",
  trust: "measured",
  n_params: 10_000_000,
  tokens_seen: null,
  checkpoint_sha256: run_id.padEnd(64, "0"),
  step: 1000,
  started_at: "2026-09-01T00:00:00Z",
  finished_at: "2026-09-02T00:00:00Z",
  categories: ["en", "pl"],
  en: { eff: null, arc_easy: null, blimp: null, wiki_byte_ppl: null, ...en },
  pl: { multiblimp: null, eff: null, ...pl },
  ...extras,
});
const ids = (rows) => rows.map((item) => item.run_id);

test("size buckets are disjoint with inclusive decimal upper bounds", () => {
  assert.equal(sizeBucket(16_000_000), "16");
  assert.equal(sizeBucket(16_000_001), "32");
  assert.equal(sizeBucket(150_000_000), "150");
  assert.equal(sizeBucket(150_000_001), "150+");
  const rows = [
    row("small", { n_params: 16_000_000 }),
    row("next", { n_params: 16_000_001 }),
  ];
  assert.deepEqual(
    ids(filterRows(rows, { category: "en", size: "16", hideReported: false })),
    ["small"],
  );
  assert.deepEqual(
    ids(filterRows(rows, { category: "en", size: "all", hideReported: false })),
    ["small", "next"],
  );
});

test("missing values sort last in both directions and ties keep their order", () => {
  const rows = [
    row("missing"),
    row("tie-a", { en: { wiki_byte_ppl: 2 } }),
    row("low", { en: { wiki_byte_ppl: 1 } }),
    row("nan", { en: { wiki_byte_ppl: NaN } }),
    row("tie-b", { en: { wiki_byte_ppl: 2 } }),
  ];
  assert.deepEqual(ids(sortRows(rows, "wiki_byte_ppl", "asc")), [
    "low",
    "tie-a",
    "tie-b",
    "missing",
    "nan",
  ]);
  assert.deepEqual(ids(sortRows(rows, "wiki_byte_ppl", "desc")), [
    "tie-a",
    "tie-b",
    "low",
    "missing",
    "nan",
  ]);
  const dated = [
    row("undated", { finished_at: null, started_at: "bad" }),
    row("dated"),
  ];
  assert.deepEqual(ids(sortRows(dated, "date", "asc")), ["dated", "undated"]);
});

test("each category ranks by its own axis: EN by eff, PL by MultiBLiMP-pl, never by eff-PL", () => {
  const rows = [
    row("a", { en: { eff: 40 }, pl: { multiblimp: 70, eff: 1 } }),
    row("b", { en: { eff: 55 }, pl: { multiblimp: 60, eff: 99 } }),
    row("c", { en: { eff: 55 }, pl: { multiblimp: 50 } }),
  ];
  assert.deepEqual([...rankRows(rows, "en")], [
    ["b", 1],
    ["c", 1],
    ["a", 3],
  ]);
  assert.deepEqual([...rankRows(rows, "pl")], [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
});

test("category and self-reported filters; rows measured by track are never hidden as self-reported", () => {
  const rows = [
    row("en-only", { categories: ["en"] }),
    row("reported", { trust: "reported", categories: ["pl"] }),
    row("track", { trust: "track", categories: ["pl"] }),
    row("both"),
  ];
  assert.deepEqual(
    ids(filterRows(rows, { category: "pl", size: "all", hideReported: false })),
    ["reported", "track", "both"],
  );
  assert.deepEqual(
    ids(filterRows(rows, { category: "pl", size: "all", hideReported: true })),
    ["track", "both"],
  );
});

test("provenance line omits the step and checkpoint a server evaluation did not record", () => {
  assert.equal(
    checkpointDetails(row("aaaaaaaabbbb", { label: "final checkpoint (result)", evaluated_at: null })),
    "final checkpoint (result) · step 1,000 · ckpt aaaaaaaa",
  );
  const measured = checkpointDetails(
    row("server", {
      label: "latest server evaluation",
      evaluated_at: "2026-09-20T12:00:00Z",
      step: null,
      checkpoint_sha256: null,
    }),
  );
  assert.match(measured, /^latest server evaluation · 20 Sept? 2026$/);
});

test("only external rows with a Hugging Face tree URL get an outbound link", () => {
  const url = "https://huggingface.co/org/model/tree/0123abcd";
  assert.equal(hfLink(row("ext", { kind: "external", hf_url: url })), url);
  assert.equal(
    hfLink(row("ext", { kind: "external", hf_url: "javascript:alert(1)" })),
    null,
  );
  assert.equal(hfLink(row("track", { hf_url: url })), null);
});
