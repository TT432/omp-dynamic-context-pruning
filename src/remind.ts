/**
 * Over-threshold compress reminder.
 *
 * dcp is model-driven: nothing forces a compress, and omp auto-compaction is
 * commonly disabled in favor of dcp. If the model simply forgets, the context
 * grows past the window and the session stalls (observed 2026-10-01: 264k
 * tokens on a 256k window, turns dying with stopReason "length"). This module
 * appends a synthetic user message to the LLM-facing copy (never persisted)
 * whenever the estimated post-compression context crosses a threshold, urging
 * an immediate compress.
 *
 * Estimate: newest assistant message with a provider usage report anchors the
 * total (that report describes the transformed prompt of the previous
 * request); messages after it are counted locally at ~4 chars/token. Without
 * any usage report the whole conversation is counted locally. Known
 * limitation: right after a compress the newest usage report can still be the
 * stale pre-compression one, so the reminder may fire once more before the
 * next turn's fresh report corrects it.
 *
 * Threshold (env DCP_REMIND_THRESHOLD, parsed in index.ts):
 *   0 < v < 1  → fraction of the model's context window (default 0.8);
 *   v >= 1     → absolute token count;
 *   v <= 0     → disabled.
 */

import type { AgentMessage, ContentBlock, ExtensionContext, MessageUsage } from "./omp";
import { scanAnchors } from "./anchors";

/** Prefix identifying the synthetic reminder (appears only in the LLM-facing copy). */
export const REMIND_MARKER = "[dcp:context]";

const CHARS_PER_TOKEN = 4;

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

/**
 * Append the compress reminder to the LLM-facing message copy when the
 * estimated context crosses the budget. Returns the input array unchanged
 * (same reference) when no reminder is warranted.
 */
export function maybeAppendReminder(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  threshold: number,
): AgentMessage[] {
  const budget = remindBudget(threshold, ctx);
  if (budget === undefined || messages.length === 0) return messages;
  const tokens = estimateContextTokens(messages);
  if (tokens < budget) return messages;

  const anchors = scanAnchors(messages)
    .map((a) => `"${a.name}"`)
    .join(", ");
  const window = resolveContextWindow(ctx);
  const pct = window ? ` (${Math.round((tokens / window) * 100)}% of the ${window}-token window)` : "";
  const text =
    `${REMIND_MARKER} Context is at ~${tokens} tokens${pct}. Compress NOW: ` +
    `call compress with startAnchor one of ${anchors || '"session_start"'} and a complete technical ` +
    `summary of everything since that anchor. Finish the compress before starting any new work.`;
  return [...messages, { role: "user", content: [{ type: "text", text }] }];
}
