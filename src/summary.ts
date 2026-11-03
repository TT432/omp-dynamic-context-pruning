/**
 * Summary shape — advisory, never a gate.
 *
 * The slot list and the `证据:` convention live in the tool description and in
 * the compress result as *warnings*: a summary that ignores them still
 * compresses. Two reasons, both learned the hard way:
 *
 *  - a rejection costs a full turn (the draft is re-sent), and the old
 *    validators rejected 17 of 20 compressions in session 01a19fdd, 9 of them
 *    for a locator "whitelist" that demanded a `:` `/` `@` `#` or `\` and
 *    therefore refused a real commit hash, real root-level filenames and the
 *    `git log` form its own error text advertised as acceptable;
 *  - the mechanical checks measured the *shape* of a summary, not the value of
 *    what it kept, and a passing summary could still assert a wrong default
 *    (`spawn_chance` 1.0 vs the real 0.2) which then became the only record.
 *
 * What remains is structural parsing, used for two things the code actually
 * needs: rendering an index line for an ancestor block, and telling the model
 * (in the compress result) where its own summary deviates from the requested
 * shape. Nothing is refused; dcp depends on the model's own discipline.
 */

/** Slot headers, in the recommended order. */
export const SUMMARY_SLOTS = ["当前任务", "已完成", "未完成", "约束", "文件与命令", "在跑作业与句柄"] as const;

export type SummarySlot = (typeof SUMMARY_SLOTS)[number];

/** Placeholder for a slot with nothing to report. */
const NONE = "无";

export interface SummaryBullet {
  slot: SummarySlot | null;
  fact: string;
  /** Text after `证据:`, or "" when the bullet carries no pointer. */
  evidence: string;
}

export interface ParsedSummary {
  bullets: SummaryBullet[];
  bySlot: Map<SummarySlot, SummaryBullet[]>;
  /** Deviations from the requested shape — advisory, never blocking. */
  problems: string[];
}

/** Copy-paste template for the tool description. */
export const SUMMARY_TEMPLATE = `${SUMMARY_SLOTS.map((slot) => `## ${slot}\n- 事实 证据: <定位>`).join("\n")}`;

const SLOT_LIST = SUMMARY_SLOTS.join(" / ");
const EVIDENCE_RE = /^(.*)\s*证据\s*[:：]\s*(\S.*)$/s;

/**
 * Parse a summary into bullets, collecting shape deviations instead of
 * throwing. Text that does not follow the slot structure at all is kept as a
 * single free-form bullet so nothing the model wrote is lost from the index.
 */
export function parseSummary(text: string): ParsedSummary {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const bySlot = new Map<SummarySlot, SummaryBullet[]>();
  const bullets: SummaryBullet[] = [];
  const problems: string[] = [];
  let current: SummarySlot | null = null;
  let sawHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const where = `第 ${i + 1} 行`;

    if (line.startsWith("#")) {
      sawHeader = true;
      const name = line.replace(/^#+\s*/, "").trim();
      const index = SUMMARY_SLOTS.indexOf(name as SummarySlot);
      if (index < 0) {
        problems.push(`${where}：槽位「${name}」不在建议列表里（${SLOT_LIST}）`);
        current = null;
        continue;
      }
      if (bySlot.has(name as SummarySlot)) problems.push(`${where}：槽位「${name}」重复出现`);
      current = name as SummarySlot;
      if (!bySlot.has(current)) bySlot.set(current, []);
      continue;
    }

    const body = line.startsWith("- ") ? line.slice(2).trim() : line;
    if (!line.startsWith("- ") && current !== null) {
      problems.push(`${where}：槽位「${current}」下的内容建议以「- 」开头`);
    }
    if (body.length === 0) continue;

    const match = EVIDENCE_RE.exec(body);
    const fact = (match ? match[1] : body).trim();
    const evidence = match ? match[2].trim() : "";
    if (fact.length > 0 && fact !== NONE && evidence.length === 0) {
      problems.push(`${where}：建议以「证据: <定位>」结尾，方便下一轮重读原始出处`);
    }
    const bullet: SummaryBullet = { slot: current, fact, evidence };
    bullets.push(bullet);
    if (current !== null) bySlot.get(current)!.push(bullet);
  }

  if (!sawHeader) {
    problems.push(`摘要没有槽位标题；建议使用 ${SLOT_LIST}`);
  } else {
    const missing = SUMMARY_SLOTS.filter((slot) => !bySlot.has(slot) || bySlot.get(slot)!.length === 0);
    if (missing.length > 0) problems.push(`摘要缺少槽位：${missing.join(" / ")}`);
    const task = bySlot.get(SUMMARY_SLOTS[0]);
    if (task && task.every((b) => b.fact === NONE || b.fact.length === 0)) {
      problems.push(`槽位「${SUMMARY_SLOTS[0]}」建议写明实际任务`);
    }
  }

  return { bullets, bySlot, problems };
}

/** Advisory warning block appended to a compress result, or "" when clean. */
export function formatProblems(problems: string[]): string {
  if (problems.length === 0) return "";
  return `\n摘要形状提示（已压缩，未拒绝）：\n${problems.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * One-line gist of a block for the ancestor index: its 当前任务 bullet, else
 * its first bullet, trimmed to keep the index cheap.
 */
export function gistOf(summary: string, max = 160): string {
  const parsed = parseSummary(summary);
  const task = parsed.bySlot.get(SUMMARY_SLOTS[0])?.find((b) => b.fact !== NONE && b.fact.length > 0);
  const source = task?.fact ?? parsed.bullets.find((b) => b.fact !== NONE && b.fact.length > 0)?.fact ?? "";
  const flat = source.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}
