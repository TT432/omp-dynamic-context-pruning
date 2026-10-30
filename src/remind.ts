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

/**
 * `session_start` is not a peer of the named anchors: it wipes everything and
 * therefore demands force + the strict tier. Listing it inside "startAnchor one
 * of ..." made the reminder recommend a call that fails validation, so it is
 * called out separately.
 */
const FULL_SESSION_HINT =
  'Do not reach for "session_start" as a shortcut: a full-session wipe needs force=true, the strict summary tier, and must merge every locator of the block it absorbs.';

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

/** Total tool calls in the (transformed) conversation. */
export function countToolCalls(messages: AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (isToolCallBlock(block)) count++;
  }
  return count;
}

/**
 * Tool calls issued since the last compression, measured against the durable
 * watermark instead of a scan for a compress call.
 *
 * The scan was wrong whenever the compress went through a channel that leaves
 * no `write({path:"xd://compress"})` block — notably the eval kernel
 * (`await tool.write(...)`) and any programmatic caller. The compression still
 * ran and still replaced the context, but the counter kept growing, so every
 * later request claimed a budget overrun. The watermark is written by
 * `compress.execute` itself, so every path is accounted for.
 */
export function toolCallsSinceLastCompress(messages: AgentMessage[], mark = 0): number {
  return Math.max(0, countToolCalls(messages) - mark);
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
  mark = 0,
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
          `call compress with startAnchor one of ${anchorList(messages) || '"your own anchor"'} and a complete technical ` +
          `summary of everything since that anchor. Finish the compress before starting any new work. ` +
          `${FULL_SESSION_HINT}`,
      );
    }
  }

  if (finishedTodoSet(messages) !== null) {
    return append(
      messages,
      `${UNIT_MARKER} The todo set just completed — that is a work-unit boundary. ` +
        `Place an anchor at the start of the next unit, then compress the finished one: ` +
        `compress with startAnchor one of ${anchorList(messages) || '"your own anchor"'}, and make the summary state ` +
        `当前任务 / 刚完成的动作 / 下一步具体动作. ${FULL_SESSION_HINT}`,
    );
  }

  if (policy.toolCallBudget > 0) {
    const used = toolCallsSinceLastCompress(messages, mark);
    if (used >= policy.toolCallBudget) {
      return append(
        messages,
        `${BUDGET_MARKER} ${used} tool calls have run since the last compress (budget ${policy.toolCallBudget}). ` +
          `If this stretch has converged, place an anchor and compress it now (startAnchor one of ` +
          `${anchorList(messages) || '"your own anchor"'}); if it has not, keep working — this reminder repeats until you compress. ` +
          `${FULL_SESSION_HINT}`,
      );
    }
  }

  return messages;
}

function append(messages: AgentMessage[], text: string): AgentMessage[] {
  return [...messages, { role: "user", content: [{ type: "text", text }] }];
}
