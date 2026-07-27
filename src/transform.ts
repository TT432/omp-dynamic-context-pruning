/**
 * Context transform — applies compression blocks to the LLM-facing message
 * copy on every provider request. Storage is never touched (INV-1: the hook
 * receives a deep clone from hooks.ts).
 *
 * Per block:
 *   - whole messages in (startMsgIdx, endMsgIdx) are elided — for session_start
 *     starts, [firstUser+1, endMsgIdx);
 *   - the start anchor's add_anchor tool_use/tool_result blocks are stripped
 *     (start anchor consumed; session_start is virtual and kept);
 *   - the compress call itself (tool_use + tool_result, by id) is stripped;
 *   - the summary is injected right after the end anchor's tool_result message.
 *
 * Blocks whose anchors no longer resolve (fork/compaction residue) are dropped
 * and the state marked dirty so a later flush persists the cleanup.
 */

import type { AgentMessage, ContentBlock } from "./omp";
import type { Logger } from "./logger";
import type { CompressionBlock, SessionState } from "./state";
import { findToolResultIndex, findToolUseIndex, firstUserMessageIndex, isToolResultBlock, isToolUseBlock } from "./anchors";
import { SESSION_START_MARKER, formatCompressedSummary } from "./prompts";

interface ResolvedBlock {
  block: CompressionBlock;
  /** First whole-elided message index. */
  lo: number;
  /** End anchor message index (exclusive elision bound). */
  hi: number;
  /** Original message index after which the summary is injected. */
  injectAfter: number;
}

function resolveBlocks(state: SessionState, logger: Logger, messages: AgentMessage[]): ResolvedBlock[] {
  const firstUser = firstUserMessageIndex(messages);
  const resolved: ResolvedBlock[] = [];
  const survivors: CompressionBlock[] = [];
  let dropped = false;

  for (const block of state.blocks) {
    const hi = findToolUseIndex(messages, block.endToolUseId);
    let lo = -1;
    if (block.startToolUseId === null) {
      if (firstUser >= 0) lo = firstUser + 1;
    } else {
      const startIdx = findToolUseIndex(messages, block.startToolUseId);
      if (startIdx >= 0) lo = startIdx + 1;
    }
    if (hi < 0 || lo < 0 || lo >= hi) {
      logger.warn("Dropping unresolvable compression block", { blockId: block.id, range: [block.startName, block.endName], hi, lo });
      dropped = true;
      continue;
    }
    const endResultIdx = findToolResultIndex(messages, block.endToolUseId);
    resolved.push({ block, lo, hi, injectAfter: Math.max(hi, endResultIdx) });
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
  const injectAt = new Map<number, CompressionBlock[]>();
  for (const r of resolved) {
    for (let i = r.lo; i < r.hi; i++) elideWhole.add(i);
    if (r.block.startToolUseId !== null) stripIds.add(r.block.startToolUseId);
    stripIds.add(r.block.compressCallId);
    const list = injectAt.get(r.injectAfter) ?? [];
    list.push(r.block);
    injectAt.set(r.injectAfter, list);
  }

  const out: AgentMessage[] = [];
  const pushInjections = (idx: number): void => {
    const list = injectAt.get(idx);
    if (!list) return;
    for (const b of list) {
      logger.debug("Injected compress summary", { blockId: b.id });
      out.push(syntheticText(formatCompressedSummary(b.startName, b.endName, b.summary)));
    }
  };

  for (let i = 0; i < messages.length; i++) {
    if (elideWhole.has(i)) continue;
    const msg = messages[i];
    let kept = msg;
    if (stripIds.size > 0 && Array.isArray(msg.content)) {
      const filtered = msg.content.filter((block: ContentBlock) => {
        if (isToolUseBlock(block) && stripIds.has(block.id)) return false;
        if (isToolResultBlock(block) && stripIds.has(block.tool_use_id)) return false;
        return true;
      });
      if (filtered.length !== msg.content.length) {
        if (filtered.length === 0) {
          pushInjections(i);
          continue;
        }
        kept = { ...msg, content: filtered };
      }
    }
    out.push(kept);
    if (i === firstUser) {
      out.push(syntheticText(SESSION_START_MARKER));
    }
    pushInjections(i);
  }

  return out;
}

function syntheticText(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
