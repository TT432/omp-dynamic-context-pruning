/**
 * Context transform — applies compression blocks to the LLM-facing message
 * copy on every provider request. Storage is never touched (INV-1: the hook
 * receives a deep clone from hooks.ts).
 *
 * Per block:
 *   - whole messages in (startMsgIdx, endMsgIdx) are elided — for session_start
 *     starts, [firstUser+1, endMsgIdx);
 *   - the start anchor's add_anchor toolCall block and its toolResult message
 *     are stripped (start anchor consumed; session_start is virtual and kept);
 *   - the compress call itself (toolCall + toolResult, by id) is stripped;
 *   - the summary is injected right before the end anchor's message — it
 *     takes the place of the elided span, and the end anchor follows it.
 *     Chained blocks (new start = old end) therefore accumulate summaries
 *     in order instead of absorbing them.
 *
 * Blocks whose anchors no longer resolve (fork/compaction residue) are dropped
 * and the state marked dirty so a later flush persists the cleanup.
 *
 * Message shape: pi-mono — assistant messages carry toolCall blocks; tool
 * results are standalone toolResult messages keyed by toolCallId.
 */

import type { AgentMessage, ContentBlock } from "./omp";
import type { Logger } from "./logger";
import type { CompressionBlock, SessionState } from "./state";
import { findToolCallIndex, firstUserMessageIndex, isToolCallBlock } from "./anchors";
import { SESSION_START_MARKER, formatCompressedSummary } from "./prompts";

interface ResolvedBlock {
  block: CompressionBlock;
  /** First whole-elided message index. */
  lo: number;
  /** End anchor message index (exclusive elision bound; summary goes before it). */
  hi: number;
}

function resolveBlocks(state: SessionState, logger: Logger, messages: AgentMessage[]): ResolvedBlock[] {
  const firstUser = firstUserMessageIndex(messages);
  const resolved: ResolvedBlock[] = [];
  const survivors: CompressionBlock[] = [];
  let dropped = false;

  for (const block of state.blocks) {
    const hi = findToolCallIndex(messages, block.endToolCallId);
    let lo = -1;
    if (block.startToolCallId === null) {
      if (firstUser >= 0) lo = firstUser + 1;
    } else {
      const startIdx = findToolCallIndex(messages, block.startToolCallId);
      if (startIdx >= 0) lo = startIdx + 1;
    }
    if (hi < 0 || lo < 0 || lo >= hi) {
      logger.warn("Dropping unresolvable compression block", { blockId: block.id, range: [block.startName, block.endName], hi, lo });
      dropped = true;
      continue;
    }
    resolved.push({ block, lo, hi });
    survivors.push(block);
  }

  if (dropped) {
    state.blocks = survivors;
    state.dirty = true;
  }
  return resolved;
}

export function applyCompressions(state: SessionState, logger: Logger, messages: AgentMessage[]): AgentMessage[] {
  const firstUser = firstUserMessageIndex(messages);
  const resolved = resolveBlocks(state, logger, messages);

  const elideWhole = new Set<number>();
  const stripIds = new Set<string>();
  const injectBefore = new Map<number, CompressionBlock[]>();
  for (const r of resolved) {
    for (let i = r.lo; i < r.hi; i++) elideWhole.add(i);
    if (r.block.startToolCallId !== null) stripIds.add(r.block.startToolCallId);
    stripIds.add(r.block.compressCallId);
    const list = injectBefore.get(r.hi) ?? [];
    list.push(r.block);
    injectBefore.set(r.hi, list);
  }

  const out: AgentMessage[] = [];
  const pushInjections = (idx: number): void => {
    const list = injectBefore.get(idx);
    if (!list) return;
    for (const b of list) {
      logger.debug("Injected compress summary", { blockId: b.id });
      out.push(syntheticText(formatCompressedSummary(b.startName, b.endName, b.summary)));
    }
  };

  for (let i = 0; i < messages.length; i++) {
    if (elideWhole.has(i)) continue;
    pushInjections(i); // summaries take the place of the elided span, before the end anchor
    const msg = messages[i];
    // toolResult messages of stripped calls (start anchor / compress) go away wholesale
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string" && stripIds.has(msg.toolCallId)) {
      continue;
    }
    let kept = msg;
    if (stripIds.size > 0 && Array.isArray(msg.content)) {
      const filtered = msg.content.filter((block: ContentBlock) => !(isToolCallBlock(block) && stripIds.has(block.id)));
      if (filtered.length !== msg.content.length) {
        if (filtered.length === 0) continue;
        kept = { ...msg, content: filtered };
      }
    }
    out.push(kept);
    if (i === firstUser) {
      out.push(syntheticText(SESSION_START_MARKER));
    }
  }

  return out;
}

function syntheticText(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
