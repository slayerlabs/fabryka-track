export type Inline = { kind: "text" | "strong" | "code"; text: string };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] };

const MARKER = /^<!--\s*(START|END)-[A-Z -]+\s*-->$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const ITEM = /^\s*[-*]\s+/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}/;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const SPAN = /`([^`]+)`|\*\*([^*]+)\*\*/g;

export function inlines(source: string): Inline[] {
  const text = source.replace(LINK, "$1");
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(SPAN)) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    out.push(match[1] !== undefined ? { kind: "code", text: match[1] } : { kind: "strong", text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => inlines(cell.trim().replaceAll("\\|", "|")));

const isTable = (lines: string[], i: number) => lines[i].trim().startsWith("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]);

function startsBlock(lines: string[], i: number) {
  const line = lines[i];
  return line.startsWith("```") || HEADING.test(line) || ITEM.test(line) || MARKER.test(line.trim()) || isTable(lines, i);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || MARKER.test(line.trim())) {
      i++;
    } else if (line.startsWith("```")) {
      const close = lines.findIndex((candidate, j) => j > i && candidate.startsWith("```"));
      const end = close < 0 ? lines.length : close;
      blocks.push({ kind: "code", text: lines.slice(i + 1, end).join("\n") });
      i = end + 1;
    } else if (HEADING.test(line)) {
      const [, hashes, text] = HEADING.exec(line)!;
      blocks.push({ kind: "heading", level: hashes.length as 1 | 2 | 3 | 4, inlines: inlines(text) });
      i++;
    } else if (ITEM.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && ITEM.test(lines[i])) items.push(inlines(lines[i++].replace(ITEM, "")));
      blocks.push({ kind: "list", items });
    } else if (isTable(lines, i)) {
      const header = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", header, rows });
    } else {
      const paragraph = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) paragraph.push(lines[i++].trim());
      blocks.push({ kind: "paragraph", inlines: inlines(paragraph.join(" ")) });
    }
  }
  return blocks;
}

function scalar(value: string) {
  const text = value.trim();
  if (!text.startsWith('"')) return text;
  try {
    return String(JSON.parse(text));
  } catch {
    return text;
  }
}

function frontRows(front: string[]): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of front) {
    const item = /^- (.*)$/.exec(line);
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (item && rows.length) {
      const last = rows[rows.length - 1];
      last[1] = last[1] ? `${last[1]}, ${scalar(item[1])}` : scalar(item[1]);
    } else if (pair) rows.push([pair[1], scalar(pair[2])]);
  }
  return rows;
}

export function parseDatasheet(markdown: string): { front: [string, string][]; blocks: Block[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return { front: [], blocks: parseBlocks(lines) };
  return { front: frontRows(lines.slice(1, end)), blocks: parseBlocks(lines.slice(end + 1)) };
}
