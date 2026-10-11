import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "../frontend/src/uploads/bytes.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

test("sizes use binary units up to GiB", () => {
  for (const [n, text] of [
    [0, "0 B"], [1023, "1,023 B"], [1024, "1.0 KiB"], [1536, "1.5 KiB"], [5 * MIB, "5.0 MiB"],
    [512 * MIB, "512.0 MiB"], [GIB, "1.0 GiB"], [10 * GIB, "10.0 GiB"], [2.5 * GIB, "2.5 GiB"],
  ]) assert.equal(formatBytes(n), text);
});

test("a size that rounds up to the next unit is shown in that unit", () => {
  assert.equal(formatBytes(MIB - 1), "1.0 MiB");
  assert.equal(formatBytes(GIB - 1), "1.0 GiB");
});

test("a value that is not a size shows a dash", () => {
  for (const n of [-1, Number.NaN, Infinity]) assert.equal(formatBytes(n), "—");
});
