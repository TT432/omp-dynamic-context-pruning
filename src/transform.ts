/**
 * Context transform — applies compression blocks to the LLM-facing message
 * copy on every provider request. Storage is never touched (the hook receives a
 * deep clone from hooks.ts).
 *
 * Only *live* blocks (supersededBy === null) drive the transform; a block that
 * was absorbed by a newer one keeps its text in state but no longer elides
 * anything, because its span already lies inside the newer block's span. Those
 * ancestors are rendered as one-line index lines, not as full text — the chain
 * costs O(history) in lines, not in bytes.
 *
 * Per live block:
 *   - whole messages in (startMsgIdx, compressMsgIdx) are elided — for
 *     session_start starts, [firstUser+1, compressMsgIdx);
 *   - the start anchor's add_anchor toolCall block and its toolResult message
 *     are stripped (start anchor consumed; session_start is virtual and kept);
 *     a message left without tool calls by stripping is dropped outright —
 *     a surviving text-only shell reads as "announce tool calls, end turn"
 *     and teaches the model to stall after every compress;
 *   - the compress call itself and its toolResult are kept — it is the
 *     implicit end of the span, and the success confirmation staying in
 *     context tells future turns the compression happened;
 *   - the summary (plus the ancestor index) is injected right before the
 *     compress call's message — it takes the place of the elided span.
 *
 * Blocks whose anchors or compress call no longer resolve (fork/compaction
 * residue) are dropped and the state marked dirty so a later flush persists
 * the cleanup. Superseded blocks are text-only; they are never dropped.
 *
 * Message shape: pi-mono — assistant messages carry toolCall blocks; tool
 * results are standalone toolResult messages keyed by toolCallId.
 */

import type { AgentMessage, ContentBlock } from "./omp";
import type { Logger } from "./logger";
import type { CompressionBlock, SessionState } from "./state";
import { ancestorsOf } from "./state";
import { findToolCallIndex, firstUserMessageIndex, isToolCallBlock } from "./anchors";
import { SESSION_START_MARKER, formatCompressedSummary, type RenderedBlock } from "./prompts";
import { gistOf } from "./summary";

interface ResolvedBlock {
  block: CompressionBlock;
  /** First whole-elided message index. */
  lo: number;
  /** Compress call message index (exclusive elision bound; summary goes before it). */
  hi: number;
}

function resolveBlocks(state: SessionState, logger: Logger, messages: AgentMessage[]): ResolvedBlock[] {
  const firstUser = firstUserMessageIndex(messages);
  const resolved: ResolvedBlock[] = [];
  const survivors: CompressionBlock[] = [];
  let dropped = false;

  for (const block of state.blocks) {
    // Absorbed blocks are pure text: their summary is rendered through the
    // child's index and their span no longer matters.
    if (block.supersededBy !== null) {
      survivors.push(block);
      continue;
    }
    const hi = findToolCallIndex(messages, block.compressCallId);
    let lo = -1;
    if (block.startToolCallId === null) {
      if (firstUser >= 0) lo = firstUser + 1;
    } else {
      const startIdx = findToolCallIndex(messages, block.startToolCallId);
      if (startIdx >= 0) lo = startIdx + 1;
    }
    if (hi < 0 || lo < 0 || lo >= hi) {
      logger.warn("Dropping unresolvable compression block", { blockId: block.id, from: block.startName, hi, lo });
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

/** Summary + ancestor index for one live block. */
export function renderBlock(blocks: CompressionBlock[], block: CompressionBlock): RenderedBlock {
  return {
    startName: block.startName,
    id: block.id,
    summary: block.summary,
    ancestors: ancestorsOf(blocks, block).map((a) => ({ id: a.id, startName: a.startName, gist: gistOf(a.summary) })),
  };
}

export function applyCompressions(state: SessionState, logger: Logger, messages: AgentMessage[]): AgentMessage[] {
  const firstUser = firstUserMessageIndex(messages);
  const resolved = resolveBlocks(state, logger, messages);

  const elideWhole = new Set<number>();
  const stripIds = new Set<string>();
  const injectBefore = new Map<number, ResolvedBlock[]>();
  for (const r of resolved) {
    for (let i = r.lo; i < r.hi; i++) elideWhole.add(i);
    if (r.block.startToolCallId !== null) stripIds.add(r.block.startToolCallId);
    const list = injectBefore.get(r.hi) ?? [];
    list.push(r);
    injectBefore.set(r.hi, list);
  }

  const out: AgentMessage[] = [];
  const pushInjections = (idx: number): void => {
    const list = injectBefore.get(idx);
    if (!list) return;
    for (const r of list) {
      logger.debug("Injected compress summary", { blockId: r.block.id, ancestors: r.block.parentIds });
      out.push(syntheticText(formatCompressedSummary(renderBlock(state.blocks, r.block))));
    }
  };

  // Orphan guard: a kept toolCall whose toolResult message was elided would
  // break provider-side call/result pairing (HTTP 400) — strip the call too.
  // Typical case: the start anchor's message also carried other tool calls
  // whose results fall inside the elided span.
  if (elideWhole.size > 0) {
    const resultIndexById = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "toolResult" && typeof m.toolCallId === "string" && !resultIndexById.has(m.toolCallId)) {
        resultIndexById.set(m.toolCallId, i);
      }
    }
    for (let i = 0; i < messages.length; i++) {
      if (elideWhole.has(i)) continue;
      const content = messages[i].content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isToolCallBlock(block)) continue;
        const rIdx = resultIndexById.get(block.id);
        if (rIdx !== undefined && elideWhole.has(rIdx)) stripIds.add(block.id);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (elideWhole.has(i)) continue;
    pushInjections(i); // summaries take the place of the elided span, before the compress call
    const msg = messages[i];
    // toolResult messages of stripped calls (start anchor / compress) go away wholesale
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string" && stripIds.has(msg.toolCallId)) {
      continue;
    }
    let kept = msg;
    if (stripIds.size > 0 && Array.isArray(msg.content)) {
      const filtered = msg.content.filter((block: ContentBlock) => !(isToolCallBlock(block) && stripIds.has(block.id)));
      if (filtered.length !== msg.content.length) {
        // Stripping can leave a message with no tool calls at all. A
        // thinking-only shell gets the request rejected (HTTP 400: assistant
        // must not be empty); a text-only shell is worse — it survives as an
        // assistant turn that announces tool calls ("现在调用 X：") and then
        // ends, teaching the model to do exactly that (observed live: stalls
        // of 20+ text-only turns after every compress). Both are dropped
        // outright; the injected summary already carries the information.
        if (!filtered.some(isToolCallBlock)) continue;
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
