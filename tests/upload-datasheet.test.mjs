import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inlines, parseDatasheet } from "../frontend/src/uploads/datasheet.ts";

const SHEET = `---
pretty_name: "Wolne Lektury"
language:
- "pl"
license: "CC-BY-SA-4.0"
domains:
- "Books"
- "Social Media"
---

# Dataset Card for Wolne Lektury

<!-- START-SHORT DESCRIPTION -->
School reading list.
<!-- END-SHORT DESCRIPTION -->

## Dataset Description

<!-- START-DESC-STATS -->
- **Number of samples**: 47.96K
- **Number of tokens (cl100k_base)**: 212.40M
<!-- END-DESC-STATS -->

<!-- START-SAMPLE -->
\`\`\`py
{
  "id": "wl-000001"
}
\`\`\`

- \`id\` (\`str\`): A unique identifier. See [Source](#source).
<!-- END-SAMPLE -->

## License Information

| License | Records |
|---|---|
| \`CC-BY-4.0\` | 3 |
| \`a\\|b\` | 1 |
`;

const REAL = readFileSync(new URL("./fixtures/datasheet-real.md", import.meta.url), "utf8");

test("the frontmatter becomes rows and lists become comma-joined values", () => {
  assert.deepEqual(parseDatasheet(SHEET).front, [
    ["pretty_name", "Wolne Lektury"], ["language", "pl"], ["license", "CC-BY-SA-4.0"], ["domains", "Books, Social Media"],
  ]);
});

test("headings, lists, code, tables and paragraphs come out in order without marker lines", () => {
  const blocks = parseDatasheet(SHEET).blocks;
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "heading", "list", "code", "list", "heading", "table"]);
  assert.equal(blocks[4].text, '{\n  "id": "wl-000001"\n}');
  assert.deepEqual(blocks[3].items[0], [{ kind: "strong", text: "Number of samples" }, { kind: "text", text: ": 47.96K" }]);
  assert.deepEqual(blocks[7].rows[1], [[{ kind: "code", text: "a|b" }], [{ kind: "text", text: "1" }]]);
  assert.ok(!JSON.stringify(blocks).includes("START-"));
});

test("links keep only their text and images lose their address", () => {
  assert.deepEqual(inlines("See [Source](#source) or [x](javascript:alert)."), [{ kind: "text", text: "See Source or x." }]);
  assert.deepEqual(inlines("![pic](http://x/y.png)"), [{ kind: "text", text: "pic" }]);
});

test("raw HTML in uploader text stays literal text", () => {
  const { blocks } = parseDatasheet("## Limitations\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<!-- not a marker -->\n");
  assert.deepEqual(blocks[1], { kind: "paragraph", inlines: [{ kind: "text", text: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }] });
  assert.deepEqual(blocks[2], { kind: "paragraph", inlines: [{ kind: "text", text: "<!-- not a marker -->" }] });
});

test("malformed input still ends: open fence, table without separator, lone pipes", () => {
  const { blocks } = parseDatasheet("```\nnever closed\n| a | b |\nplain\n");
  assert.deepEqual(blocks, [{ kind: "code", text: "never closed\n| a | b |\nplain\n" }]);
  assert.deepEqual(parseDatasheet("| a | b |\nnext line\n|\n").blocks.map((block) => block.kind), ["paragraph"]);
  assert.deepEqual(parseDatasheet("").blocks, []);
  assert.deepEqual(parseDatasheet("---\nno end").front, []);
});

test("block-start lookalikes become paragraphs and the parser ends", () => {
  const lookalikes = ["#nospace", "##### five", "-dash", "**", "``", "|", "| a |\n|", "<!-- START-lower -->", "----", "- ", "\u0000"];
  for (const text of lookalikes) {
    const { blocks } = parseDatasheet(`${text}\n${text}`);
    assert.ok(blocks.length >= 1, JSON.stringify(text));
  }
  assert.equal(parseDatasheet("#nospace").blocks[0].kind, "paragraph");
  assert.equal(parseDatasheet("<!-- START-lower -->").blocks[0].kind, "paragraph");
});

test("the output of the upstream renderer parses: no markers, no links, every licence row", () => {
  const { front, blocks } = parseDatasheet(REAL);
  assert.deepEqual(front.map(([key]) => key), ["pretty_name", "language", "license", "license_name", "domains"]);
  assert.deepEqual(front[4], ["domains", "Books, Social Media"]);
  const dump = JSON.stringify(blocks);
  assert.ok(!dump.includes("START-") && !dump.includes("END-"));
  assert.ok(!dump.includes("javascript:") && !dump.includes("http://x/y.png"));
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[2][0], [{ kind: "code", text: "a|b 'c'" }]);
  const hostile = blocks.find((block) => block.kind === "paragraph" && block.inlines[0].text.startsWith("<script>"));
  assert.deepEqual(hostile.inlines, [{ kind: "text", text: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }]);
  const sample = blocks.find((block) => block.kind === "code");
  assert.ok(sample.text.includes("\\u003c!-- x --\\u003e"));
});

test("links and images are stripped the way a left-to-right reader expects", () => {
  const text = (value) => inlines(value).map((part) => part.text).join("");
  assert.equal(text("a [b](c) d ![e](f) g"), "a b d e g");
  assert.equal(text("[a [b](c)"), "a [b");
  assert.equal(text("[a] (c) [b](d"), "[a] (c) [b](d");
  assert.equal(text("[](x)[y](z)"), "y");
});

test("adversarial 1 MiB inputs parse in under a second", () => {
  const MiB = 1 << 20;
  const cases = {
    brackets: "[".repeat(MiB),
    bracketParen: "[](".repeat(MiB / 3),
    markerSpaces: `<!-- START-${" ".repeat(MiB)}x`,
    separatorSpaces: `| a |\n${" ".repeat(MiB)}x`,
    alternatingFences: "```\n".repeat(MiB / 4),
    fencesWithText: "```\nx\n".repeat(MiB / 6),
    pipes: "|".repeat(MiB),
    pipeLines: "| a |\n".repeat(MiB / 6),
    licenceCell: `| License | Records |\n|---|---|\n| \`${"[".repeat(MiB)}\` | 1 |\n`,
  };
  for (const [name, input] of Object.entries(cases)) {
    const started = performance.now();
    parseDatasheet(input);
    assert.ok(performance.now() - started < 1000, name);
  }
});
