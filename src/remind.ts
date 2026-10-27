/**
 * Compress reminders.
 *
 * dcp is model-driven: nothing forces a compress, and omp auto-compaction is
 * commonly disabled in favor of dcp. Three triggers append a synthetic user
 * message to the LLM-facing copy (never persisted):
 *
 *   1. `[dcp:context]` — estimated context crosses the token budget
 *      (DCP_REMIND_THRESHOLD). Guards against the stall observed 2026-10-01:
 *      264k tokens on a 256k window, turns dying with stopReason "length".
 *   2. `[dcp:unit]` — the newest `todo` result reports a completed item set
 *      ("All items complete" / "Remaining items (0)"). That is the work-unit
 *      boundary the global AGENTS.md used to describe in prose; the trigger
 *      makes the boundary observable instead of judged.
 *   3. `[dcp:budget]` — N tool calls have run since the last compress
 *      (DCP_REMIND_TOOLCALLS). Observed unit size in 20 sessions: ~36 tool
 *      calls per todo item (1377 calls / 38 todo ops), hence the default 40.
 *
 * Only one reminder is appended per request; token pressure wins over unit
 * boundary, which wins over the call budget. All three stop firing once the
 * span is compressed, because the reminder is computed on the already
 * transformed message copy.
 *
 * Estimate: newest assistant message with a provider usage report anchors the
 * total (that report describes the transformed prompt of the previous
 * request); messages after it are counted locally at ~4 chars/token. Without
 * any usage report the whole conversation is counted locally. Known
 * limitation: right after a compress the newest usage report can still be the
 * stale pre-compression one, so the token reminder may fire once more before
 * the next turn's fresh report corrects it.
 *
 * Threshold (env DCP_REMIND_THRESHOLD):
 *   0 < v < 1  → fraction of the model's context window (default 0.4);
 *   v >= 1     → absolute token count;
 *   v <= 0     → token trigger disabled.
 */

import type { AgentMessage, ContentBlock, ExtensionContext, MessageUsage } from "./omp";
import { isToolCallBlock, scanAnchors } from "./anchors";

/** Prefix identifying the over-threshold reminder (LLM-facing copy only). */
export const REMIND_MARKER = "[dcp:context]";
/** Prefix identifying the work-unit-boundary reminder. */
export const UNIT_MARKER = "[dcp:unit]";
/** Prefix identifying the tool-call-budget reminder. */
export const BUDGET_MARKER = "[dcp:budget]";

export const DEFAULT_TOKEN_THRESHOLD = 0.4;
export const DEFAULT_TOOLCALL_BUDGET = 40;

/** When to nudge the model to compress. */
export interface RemindPolicy {
  /** (0,1) = fraction of the context window, >=1 = absolute tokens, <=0 = off. */
  tokenThreshold: number;
  /** Tool calls since the last compress before nudging; <=0 = off. */
  toolCallBudget: number;
}

const CHARS_PER_TOKEN = 4;
const XD_WRITE_TOOL = "write";
const XD_COMPRESS_PATH = "xd://compress";
const COMPRESS_TOOL = "compress";

function num(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse a policy from env vars (unset / non-numeric → defaults). */
export function parseRemindPolicy(env: Record<string, string | undefined>): RemindPolicy {
  return {
    tokenThreshold: num(env.DCP_REMIND_THRESHOLD, DEFAULT_TOKEN_THRESHOLD),
    toolCallBudget: num(env.DCP_REMIND_TOOLCALLS, DEFAULT_TOOLCALL_BUDGET),
  };
}

function usageTokens(usage: MessageUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const total = usage.totalTokens;
  if (typeof total === "number" && total > 0) return total;
  const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return sum > 0 ? sum : undefined;
}

function blockText(block: ContentBlock): string {
  const b = block as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.thinking === "string") return b.thinking;
  if (b.type === "toolCall") {
    try {
      return JSON.stringify(b.arguments ?? "");
    } catch {
      return "";
    }
  }
  return "";
}

function messageChars(message: AgentMessage): number {
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) n += blockText(block).length;
  return n;
}

/**
 * Estimated tokens of the (already transformed) conversation. Exported for
 * tests.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const anchored = usageTokens(m.usage);
    if (anchored === undefined) continue;
    let tail = 0;
    for (let j = i + 1; j < messages.length; j++) tail += messageChars(messages[j]);
    return anchored + Math.ceil(tail / CHARS_PER_TOKEN);
  }
  let all = 0;
  for (const m of messages) all += messageChars(m);
  return Math.ceil(all / CHARS_PER_TOKEN);
}

/** Context window from the live model or omp's usage snapshot; undefined if unknown. */
export function resolveContextWindow(ctx: ExtensionContext): number | undefined {
  const fromModel = ctx.model?.contextWindow;
  if (typeof fromModel === "number" && fromModel > 0) return fromModel;
  const usage = ctx.getContextUsage?.();
  const fromUsage = usage?.contextWindow ?? usage?.limit;
  return typeof fromUsage === "number" && fromUsage > 0 ? fromUsage : undefined;
}

/** Effective token budget for the reminder, or undefined when undeterminable. */
export function remindBudget(threshold: number, ctx: ExtensionContext): number | undefined {
  if (!(threshold > 0)) return undefined; // 0 / negative / NaN → disabled
  if (threshold >= 1) return Math.floor(threshold);
  const window = resolveContextWindow(ctx);
  return window === undefined ? undefined : Math.floor(window * threshold);
}

/** True when the block is a compress call, direct or inside the xd://write envelope. */
function isCompressCall(block: ContentBlock): boolean {
  if (!isToolCallBlock(block)) return false;
  if (block.name === COMPRESS_TOOL) return true;
  if (block.name !== XD_WRITE_TOOL) return false;
  const path = block.arguments.path;
  return typeof path === "string" && path.trim() === XD_COMPRESS_PATH;
}

/**
 * Tool calls issued since the last compress call in this (transformed) copy.
 * Compressed spans are already collapsed, so this counts live work only.
 */
export function toolCallsSinceLastCompress(messages: AgentMessage[]): number {
  let lastCompress = -1;
  const positions: { msg: number; block: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      if (isCompressCall(content[j])) lastCompress = positions.push({ msg: i, block: j }) - 1;
    }
  }
  const after = lastCompress === -1 ? { msg: -1, block: -1 } : positions[lastCompress];
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      if (!isToolCallBlock(content[j])) continue;
      if (i < after.msg || (i === after.msg && j <= after.block)) continue;
      count++;
    }
  }
  return count;
}

/**
 * Text of the newest `todo` tool result when it reports a finished item set,
 * else null. Losing the todo list (post-compaction) is not a completion.
 */
export function finishedTodoSet(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage & { toolName?: string };
    if (m.role !== "toolResult" || m.toolName !== "todo") continue;
    const text = messageText(m);
    if (/All items complete/i.test(text) || /Remaining items \(0\)/i.test(text)) return text;
    return null; // newest todo result is mid-progress → no boundary
  }
  return null;
}

function messageText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => blockText(b)).join("\n");
}

function anchorList(messages: AgentMessage[]): string {
  return scanAnchors(messages)
    .map((a) => `"${a.name}"`)
    .join(", ");
}

/**
 * Append at most one reminder to the LLM-facing message copy. Returns the
 * input array unchanged (same reference) when no reminder is warranted.
 */
export function maybeAppendReminder(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  policy: RemindPolicy,
): AgentMessage[] {
  if (messages.length === 0) return messages;

  const budget = remindBudget(policy.tokenThreshold, ctx);
  if (budget !== undefined) {
    const tokens = estimateContextTokens(messages);
    if (tokens >= budget) {
      const window = resolveContextWindow(ctx);
      const pct = window ? ` (${Math.round((tokens / window) * 100)}% of the ${window}-token window)` : "";
      return append(
        messages,
        `${REMIND_MARKER} Context is at ~${tokens} tokens${pct}. Compress NOW: ` +
          `call compress with startAnchor one of ${anchorList(messages) || '"session_start"'} and a complete technical ` +
          `summary of everything since that anchor. Finish the compress before starting any new work.`,
      );
    }
  }

  if (finishedTodoSet(messages) !== null) {
    return append(
      messages,
      `${UNIT_MARKER} The todo set just completed — that is a work-unit boundary. ` +
        `Place an anchor at the start of the next unit, then compress the finished one: ` +
        `compress with startAnchor one of ${anchorList(messages) || '"session_start"'}, and make the summary state ` +
        `当前任务 / 刚完成的动作 / 下一步具体动作.`,
    );
  }

  if (policy.toolCallBudget > 0) {
    const used = toolCallsSinceLastCompress(messages);
    if (used >= policy.toolCallBudget) {
      return append(
        messages,
        `${BUDGET_MARKER} ${used} tool calls have run since the last compress (budget ${policy.toolCallBudget}). ` +
          `If this stretch has converged, place an anchor and compress it now (startAnchor one of ` +
          `${anchorList(messages) || '"session_start"'}); if it has not, keep working — this reminder repeats until you compress.`,
      );
    }
  }

  return messages;
}

function append(messages: AgentMessage[], text: string): AgentMessage[] {
  return [...messages, { role: "user", content: [{ type: "text", text }] }];
}
