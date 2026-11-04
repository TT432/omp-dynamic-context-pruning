/**
 * Compress reminders.
 *
 * dcp is model-driven: nothing forces a compress, and omp auto-compaction is
 * commonly disabled in favor of dcp. Two triggers append a synthetic user
 * message to the LLM-facing copy (never persisted):
 *
 *   1. `[dcp:context]` — estimated context crosses the token budget
 *      (DCP_REMIND_THRESHOLD). Guards against the stall observed 2026-10-01:
 *      264k tokens on a 256k window, turns dying with stopReason "length".
 *   2. `[dcp:unit]` — the newest `todo` result reports a completed item set.
 *      That is a work-unit boundary, and it is observable rather than judged.
 *
 * There is deliberately no "N tool calls since the last compress" trigger. It
 * was removed after session 01a19fdd: it fired at 40 calls, three minutes in,
 * on a context that was nowhere near the window, and the compress that followed
 * threw away the exploration the model was still using (it re-read three files
 * immediately after). Tool-call count is not context cost — one 40KB read and
 * one `todo` counted the same.
 *
 * Only one reminder is appended per request; token pressure wins.
 * `[dcp:context]` recomputes on the transformed copy, so a compression silences
 * it. `[dcp:unit]` dedupes on the todo result's toolCallId: the newest finished
 * todo result stays "finished" until the model calls `todo` again, so without a
 * watermark the reminder would repeat on every request for the rest of the
 * session.
 *
 * Estimate: newest assistant message with a provider usage report anchors the
 * total (that report describes the transformed prompt of the previous
 * request); messages after it are counted locally. Without any usage report the
 * whole conversation is counted locally. Known limitation: right after a
 * compress the newest usage report can still be the stale pre-compression one,
 * so the token reminder may fire once more before the next turn corrects it.
 *
 * Threshold (env DCP_REMIND_THRESHOLD):
 *   0 < v < 1  → fraction of the model's context window (default 0.4);
 *   v >= 1     → absolute token count;
 *   v <= 0     → token trigger disabled.
 */

import type { AgentMessage, ContentBlock, ExtensionContext, MessageUsage } from "./omp";
import { scanAnchors } from "./anchors";

/** Prefix identifying the over-threshold reminder (LLM-facing copy only). */
export const REMIND_MARKER = "[dcp:context]";
/** Prefix identifying the work-unit-boundary reminder. */
export const UNIT_MARKER = "[dcp:unit]";

export const DEFAULT_TOKEN_THRESHOLD = 0.4;

/** When to nudge the model to compress. */
export interface RemindPolicy {
  /** (0,1) = fraction of the context window, >=1 = absolute tokens, <=0 = off. */
  tokenThreshold: number;
}

const CHARS_PER_TOKEN = 4;
/** CJK text costs roughly twice as many tokens per character as ASCII. */
const CJK_CHARS_PER_TOKEN = 2;

/** A finished todo set, with the identity of the result that reported it. */
export interface FinishedUnit {
  /** toolCallId of the `todo` call that produced the result — the dedupe key. */
  id: string;
  text: string;
}

const CHAIN_ROOT_HINT =
  'Full-session compression ("session_start") is allowed and nothing you already compressed is destroyed, but a chain-root block has no ancestors: expand cannot recover anything from this span, and it is the most lossy call available. If a later live anchor exists, start there instead.';
const ORDER_HINT =
  'Place the next anchor AFTER the compress call — an anchor placed before it lies inside the span and is swallowed.';

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

/** CJK characters tokenize far denser than Latin ones — weight them separately. */
function textTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + rest / CHARS_PER_TOKEN);
}

function messageTokens(message: AgentMessage): number {
  const content = message.content;
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) n += textTokens(blockText(block));
  return n;
}

/** Provider-reported token total of the newest assistant message, if any. */
export function latestUsageTokens(messages: AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const anchored = usageTokens(m.usage);
    if (anchored !== undefined) return anchored;
  }
  return undefined;
}

/**
 * Estimated tokens of the (already transformed) conversation.
 *
 * `staleUsage` is the provider total recorded at the last compression. That
 * report describes the *pre*-compression context, so anchoring on it makes the
 * first request after every compression claim the old size and fire the token
 * reminder for a context that was just pruned (observed: ~405k claimed on a
 * context that had just been reduced to one summary). When the newest usage
 * equals the stale mark, fall back to the character heuristic.
 */
export function estimateContextTokens(messages: AgentMessage[], staleUsage = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const anchored = usageTokens(m.usage);
    if (anchored === undefined) continue;
    if (staleUsage > 0 && anchored === staleUsage) break;
    let tail = 0;
    for (let j = i + 1; j < messages.length; j++) tail += messageTokens(messages[j]);
    return anchored + tail;
  }
  let all = 0;
  for (const m of messages) all += messageTokens(m);
  return all;
}

/** Context window from the live model or omp's usage snapshot; undefined if unknown. */
export function resolveContextWindow(ctx: ExtensionContext): number | undefined {
  const fromModel = ctx.model?.contextWindow;
  if (typeof fromModel === "number" && fromModel > 0) return fromModel;
  const usage = ctx.getContextUsage?.();
  const fromWindow = usage?.contextWindow ?? usage?.limit;
  return typeof fromWindow === "number" && fromWindow > 0 ? fromWindow : undefined;
}

/** Effective token budget for the reminder, or undefined when undeterminable. */
export function remindBudget(threshold: number, ctx: ExtensionContext): number | undefined {
  if (!(threshold > 0)) return undefined; // 0 / negative / NaN → disabled
  if (threshold >= 1) return Math.floor(threshold);
  const window = resolveContextWindow(ctx);
  return window === undefined ? undefined : Math.floor(window * threshold);
}

function messageText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => blockText(b)).join("\n");
}

/**
 * Newest `todo` result when it reports a finished item set, else null.
 * Losing the todo list (post-compaction) is not a completion.
 *
 * The finished-set wording differs between hosts — observed live:
 * "Remaining items: none." + "Overall: 4/4 done, 0 open.", and the older
 * "All items complete" / "Remaining items (0)". The old pattern only matched
 * the second pair, so the unit trigger was dead code on the current host.
 */
export function finishedTodoSet(messages: AgentMessage[]): FinishedUnit | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage & { toolName?: string };
    if (m.role !== "toolResult" || m.toolName !== "todo") continue;
    const text = messageText(m);
    if (
      /All items complete/i.test(text) ||
      /Remaining items \(0\)/i.test(text) ||
      /Remaining items:\s*none/i.test(text) ||
      /\b0 open\b/i.test(text)
    ) {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : text.slice(0, 32);
      return { id, text };
    }
    return null; // newest todo result is mid-progress → no boundary
  }
  return null;
}

function anchorList(messages: AgentMessage[]): string {
  return scanAnchors(messages)
    .map((a) => `"${a.name}"`)
    .join(", ");
}

/** Mutable cursor holding the highest bracket already reported. */
export interface RemindCursor {
  remindLevel: number;
  /** toolCallId of the finished todo set already reported (dedupe). */
  unitRemindId: string | null;
}

/** Above the threshold, one reminder per further 10% of the budget. */
const REMIND_STEP_PERCENT = 10;

/**
 * Bracket index for the current estimate: 10% of the context window per step
 * (absolute thresholds step on 10% of the budget, since no window is known).
 */
export function tokenBracket(tokens: number, budget: number, window: number | undefined): number {
  const base = window !== undefined && window > 0 ? window : budget;
  return Math.floor((tokens / base) * (100 / REMIND_STEP_PERCENT));
}

export function maybeAppendReminder(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  policy: RemindPolicy,
  staleUsage = 0,
  cursor?: RemindCursor,
): AgentMessage[] {
  if (messages.length === 0) return messages;

  const budget = remindBudget(policy.tokenThreshold, ctx);
  if (budget !== undefined) {
    const tokens = estimateContextTokens(messages, staleUsage);
    if (tokens < budget) {
      if (cursor !== undefined) cursor.remindLevel = 0; // back under the threshold
    } else {
      const window = resolveContextWindow(ctx);
      const level = tokenBracket(tokens, budget, window);
      if (cursor === undefined || level > cursor.remindLevel) {
        if (cursor !== undefined) cursor.remindLevel = level;
        const pct = window ? ` (${Math.round((tokens / window) * 100)}% of the ${window}-token window)` : "";
        return append(
          messages,
          `${REMIND_MARKER} Context is at ~${tokens} tokens${pct}. Compress NOW: ` +
            `call compress with startAnchor one of ${anchorList(messages) || '"session_start"'} and a complete technical ` +
            `summary of everything since that anchor. Finish the compress before starting any new work. ` +
            `${CHAIN_ROOT_HINT} ${ORDER_HINT}`,
        );
      }
    }
  }

  const unit = finishedTodoSet(messages);
  if (unit !== null && (cursor === undefined || cursor.unitRemindId !== unit.id)) {
    if (cursor !== undefined) cursor.unitRemindId = unit.id;
    return append(
      messages,
      `${UNIT_MARKER} The todo set just completed — that is a work-unit boundary. ` +
        `Compress the finished unit NOW with startAnchor one of ${anchorList(messages) || '"session_start"'}. ` +
        `Only after it succeeds, call add_anchor for the next unit: an anchor added before the compress call is ` +
        `swallowed by this span and cannot be reused. The summary's 当前任务 must say what the next turn should do first. ` +
        `${CHAIN_ROOT_HINT}`,
    );
  }

  return messages;
}

function append(messages: AgentMessage[], text: string): AgentMessage[] {
  // Mark the injected text as a harness reminder so it is not mistaken for (or
  // forged as) ordinary user input.
  const wrapped = `<system-reminder source="dcp">\n${text}\n</system-reminder>`;
  return [...messages, { role: "user", content: [{ type: "text", text: wrapped }] }];
}
