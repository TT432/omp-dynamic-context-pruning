import { createHash } from "node:crypto";
import type { BlockKind, SourceBlock } from "./types";

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const LIST = /^\s*(?:[-+*]|\d+[.)])\s+/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const FRONTMATTER = /^---\s*$/;

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .toLowerCase();
}

function stableBlockId(text: string, headings: readonly string[]): string {
  const normalized = normalizeText(text);
  return `b_${createHash("sha256").update(`${headings.map(normalizeText).join("/")}\0${normalized}`).digest("hex").slice(0, 16)}`;
}

function isTableDelimiter(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function isTableStart(lines: string[], index: number): boolean {
  return lines[index]?.includes("|") === true && index + 1 < lines.length && isTableDelimiter(lines[index + 1]);
}

function pushBlock(out: SourceBlock[], kind: BlockKind, lines: string[], start: number, end: number, headings: readonly string[]): void {
  const text = lines.slice(start, end + 1).join("\n");
  const normalized = normalizeText(text);
  if (!normalized) return;
  const base = stableBlockId(text, headings);
  let id = base;
  let suffix = 2;
  while (out.some((block) => block.id === id)) id = `${base}_${suffix++}`;
  out.push({ id, kind, text, normalized, headingPath: [...headings], startLine: start + 1, endLine: end + 1 });
}

/** Deterministic Markdown block scan. Fences and tables are indivisible source spans. */
export function scanMarkdown(source: string): SourceBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: SourceBlock[] = [];
  const headings: string[] = [];
  let i = 0;

  if (lines.length > 0 && FRONTMATTER.test(lines[0])) {
    let end = 1;
    while (end < lines.length && !FRONTMATTER.test(lines[end])) end++;
    if (end < lines.length) {
      pushBlock(out, "frontmatter", lines, 0, end, headings);
      i = end + 1;
    }
  }

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }

    const heading = lines[i].match(HEADING);
    if (heading) {
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2].trim();
      pushBlock(out, "heading", lines, i, i, headings);
      i++;
      continue;
    }

    const fence = lines[i].match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const width = fence[1].length;
      let end = i + 1;
      const closing = new RegExp(`^\\s*${marker}{${width},}\\s*$`);
      while (end < lines.length && !closing.test(lines[end])) end++;
      if (end >= lines.length) end = lines.length - 1;
      pushBlock(out, "fence", lines, i, end, headings);
      i = end + 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      let end = i + 1;
      while (end + 1 < lines.length && lines[end + 1].includes("|") && lines[end + 1].trim()) end++;
      pushBlock(out, "table", lines, i, end, headings);
      i = end + 1;
      continue;
    }

    if (LIST.test(lines[i])) {
      const start = i;
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !HEADING.test(lines[i]) &&
        !FENCE.test(lines[i]) &&
        !isTableStart(lines, i) &&
        (LIST.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))
      ) {
        i++;
      }
      pushBlock(out, "list", lines, start, i - 1, headings);
      continue;
    }

    const start = i;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !FENCE.test(lines[i]) &&
      !LIST.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      i++;
    }
    pushBlock(out, "paragraph", lines, start, i - 1, headings);
  }

  return out;
}

export function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}
