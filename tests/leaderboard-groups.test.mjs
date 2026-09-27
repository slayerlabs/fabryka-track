import test from "node:test";
import assert from "node:assert/strict";
import {
  recipe,
  groupModels,
  sortModels,
} from "../frontend/src/pages/leaderboard-data.ts";
const row = (id, mix = [], extras = {}) => ({
  id,
  name: id,
  owner: "researcher",
  rank: 1,
  steps: 10,
  started_at: "2026-01-01",
  mix,
  ...extras,
});
test("recipe groups match public dataset weights independent of order, and split different weights", () => {
  const a = row("a", [
    { name: "Web", weight: 60 },
    { name: "Books", weight: 40 },
  ]);
  const b = row("b", [
    { name: "Books", weight: 40 },
    { name: "Web", weight: 60 },
  ]);
  const c = row("c", [
    { name: "Web", weight: 40 },
    { name: "Books", weight: 60 },
  ]);
  assert.equal(recipe(a).key, recipe(b).key);
  assert.notEqual(recipe(a).key, recipe(c).key);
  assert.deepEqual(
    groupModels([a, b, c], "recipe").map((group) => group.rows.length),
    [2, 1],
  );
});
test("undisclosed recipes never claim an exact data match", () => {
  const hidden = recipe(
    row("private", [{ name: "Private dataset", weight: 100 }]),
  );
  const partial = recipe(
    row("partial", [
      { name: "Private dataset", weight: 50 },
      { name: "Books", weight: 50 },
    ]),
  );
  assert.notEqual(hidden.key, partial.key);
  assert.match(hidden.detail, /not a matched recipe/);
  assert.notEqual(hidden.key, recipe(row("unknown")).key);
});
test("sort retains zero and puts missing and nonfinite measurements last in both directions", () => {
  const rows = [
    row("missing"),
    row("zero", [], { val_loss: 0, throughput: 0 }),
    row("high", [], { val_loss: 3, throughput: 100 }),
    row("nan", [], { val_loss: NaN, throughput: NaN }),
  ];
  assert.deepEqual(
    sortModels(rows, "val_loss").map((row) => row.id),
    ["zero", "high", "missing", "nan"],
  );
  assert.deepEqual(
    sortModels(rows, "throughput").map((row) => row.id),
    ["high", "zero", "missing", "nan"],
  );
  assert.equal(rows[0].id, "missing");
});
test("author and flat groups retain all runs", () => {
  const rows = [row("a"), row("b", [], { owner: "other" }), row("c")];
  assert.deepEqual(
    groupModels(rows, "owner").map((group) => group.rows.length),
    [2, 1],
  );
  assert.equal(groupModels(rows, "none")[0].rows.length, 3);
});
