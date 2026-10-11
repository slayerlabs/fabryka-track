import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { Sha256 } from "../frontend/src/uploads/sha256.ts";

const reference = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("whole-message digests match node:crypto around block boundaries", () => {
  for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const bytes = randomBytes(size);
    const hash = new Sha256();
    hash.update(bytes);
    assert.equal(hash.digest(), reference(bytes), `size ${size}`);
  }
});

test("random chunking of one message yields the same digest", () => {
  for (let round = 0; round < 20; round++) {
    const bytes = randomBytes(1 + Math.floor(Math.random() * 5000));
    const hash = new Sha256();
    let offset = 0;
    while (offset < bytes.length) {
      const next = Math.min(bytes.length, offset + Math.floor(Math.random() * 200));
      hash.update(bytes.subarray(offset, next));
      offset = next;
    }
    assert.equal(hash.digest(), reference(bytes));
  }
});

test("opt-in streamed SHA matches node:crypto past 512 MiB and 4 GiB", {
  skip: process.env.UPLOAD_SHA256_SLOW !== "1" ? "set UPLOAD_SHA256_SLOW=1 to hash both length boundaries" : false,
}, () => {
  const chunk = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
  for (const size of [512 * 1024 ** 2 + 1, 4 * 1024 ** 3 + 1]) {
    console.log(`SHA boundary: ${size} bytes, bounded deterministic chunks`);
    const ours = new Sha256();
    const theirs = createHash("sha256");
    for (let offset = 0; offset < size; offset += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, size - offset));
      ours.update(part);
      theirs.update(part);
    }
    assert.equal(ours.digest(), theirs.digest("hex"), `${size} bytes`);
  }
});
