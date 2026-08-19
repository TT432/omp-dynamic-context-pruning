/**
 * The two DCP tools.
 *
 * add_anchor — places a named anchor at the call site. The call itself is the
 * anchor: its provider-assigned tool-call id is the durable identity. Names are
 * unique per session and "session_start" is reserved.
 *
 * compress — replaces the span from a start anchor up to the compress call
 * itself with the model-authored summary. The end is implicit: this compress
 * call's position in the conversation. Resolves the anchor on the persisted
 * branch (positions are stable and even consumed anchors remain findable),
 * validates, absorbs fully-contained prior blocks, and records a
 * CompressionBlock. The context transform (transform.ts) applies the block to
 * future LLM requests; storage is never touched. Failed validation throws
 * before any state mutation (INV-4).
 */

import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, ToolResult } from "./omp";
import type { Logger } from "./logger";
import type { CompressionBlock, SessionState } from "./state";
import {
  ADD_ANCHOR_TOOL,
  SESSION_START_ANCHOR,
  findToolCallIndex,
  firstUserMessageIndex,
  scanAnchors,
  type AnchorRef,
} from "./anchors";
import { ADD_ANCHOR_PROMPT, COMPRESS_PROMPT } from "./prompts";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("role" in value) || typeof value.role !== "string") return false;
  if (!("content" in value)) return false;
  return typeof value.content === "string" || Array.isArray(value.content);
}

/** Messages of the persisted branch, in order. */
export function branchMessages(ctx: ExtensionContext): AgentMessage[] {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && "message" in entry && isAgentMessage(entry.message)) {
      out.push(entry.message);
    }
  }
  return out;
}

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function anchorList(anchors: AnchorRef[]): string {
  return anchors.map((a) => `"${a.name}"`).join(", ") || "(none)";
}

// ---------------------------------------------------------------------------
// add_anchor
// ---------------------------------------------------------------------------

export interface AddAnchorToolDeps {
  logger: Logger;
  zod: ExtensionAPI["zod"];
}

export function createAddAnchorTool(deps: AddAnchorToolDeps): ToolDefinition {
  const { logger, zod } = deps;
  const parameters = zod.object({
    anchor: zod.string({ description: "Unique name for this anchor (no whitespace; \"session_start\" is reserved)" }),
  });

  return {
    name: ADD_ANCHOR_TOOL,
    label: "Add anchor",
    description: ADD_ANCHOR_PROMPT,
    parameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      // omp validates params against the zod schema before execute; the cast is
      // a formality — the field is still re-checked for a precise error message.
      const p = params as { anchor?: unknown };
      if (typeof p.anchor !== "string") throw new Error('add_anchor requires a string "anchor" parameter');
      const name = p.anchor.trim();
      if (name.length === 0) throw new Error("anchor name must not be empty");
      if (name.length > 64) throw new Error(`anchor name too long (${name.length} > 64 chars)`);
      if (/\s/.test(name)) throw new Error("anchor name must not contain whitespace");
      if (name === SESSION_START_ANCHOR) {
        throw new Error(`"${SESSION_START_ANCHOR}" is reserved for the built-in anchor after the original user prompt`);
      }

      const messages = branchMessages(ctx);
      const duplicate = scanAnchors(messages).find((a) => a.name === name && a.toolCallId !== toolCallId);
      if (duplicate) {
        throw new Error(`anchor "${name}" already exists in this session; anchor names must be unique`);
      }

      logger.info("Anchor added", { name, toolCallId });
      return textResult(
        `Anchor "${name}" recorded at this point in the conversation. Cite it as startAnchor in a later compress call.`,
        { anchor: name },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

export interface CompressToolDeps {
  state: SessionState;
  logger: Logger;
  zod: ExtensionAPI["zod"];
  persist: () => void;
}

export function createCompressTool(deps: CompressToolDeps): ToolDefinition {
  const { state, logger, zod, persist } = deps;
  const parameters = zod.object({
    startAnchor: zod.string({ description: "Anchor where compression starts (consumed); \"session_start\" compresses from the original prompt" }),
    summary: zod.string({ description: "Complete technical summary replacing everything from the anchor up to this compress call; the only record future turns will have" }),
  });

  return {
    name: "compress",
    label: "Compress",
    description: COMPRESS_PROMPT,
    parameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      // omp validates params against the zod schema before execute; fields are
      // still re-checked below for precise error messages.
      const p = params as { startAnchor?: unknown; summary?: unknown };
      if (typeof p.startAnchor !== "string" || p.startAnchor.trim().length === 0) {
        throw new Error('compress requires a non-empty string "startAnchor"');
      }
      if (typeof p.summary !== "string" || p.summary.trim().length === 0) {
        throw new Error('compress requires a non-empty string "summary" — it is the only record future turns will have');
      }
      const startName = p.startAnchor.trim();
      const summary = p.summary;

      const messages = branchMessages(ctx);
      if (messages.length === 0) {
        throw new Error("no session messages available to compress; try again on a later turn");
      }
      const anchors = scanAnchors(messages);
      const byName = new Map<string, AnchorRef>();
      for (const a of anchors) byName.set(a.name, a);

      const start = byName.get(startName);
      if (!start) {
        throw new Error(`unknown startAnchor "${startName}". Available anchors: ${anchorList(anchors)}`);
      }

      // The span's end is implicit: this compress call's position. The
      // in-flight call is usually not yet appended to the branch when execute
      // runs; it lands at the end, so fall back to messages.length.
      const callIdx = findToolCallIndex(messages, toolCallId);
      const endIdx = callIdx >= 0 ? callIdx : messages.length;

      // First whole-elided message index: for a real start the anchor message
      // itself is only stripped of its anchor block, so elision starts after it;
      // for session_start elision starts right after the first user message.
      const elideFrom = start.toolCallId === null ? start.msgIndex : start.msgIndex + 1;
      if (elideFrom >= endIdx) {
        throw new Error(`range from "${startName}" to this compress call contains no messages to compress`);
      }

      const firstUser = firstUserMessageIndex(messages);
      const consumed: CompressionBlock[] = [];
      for (const b of state.blocks) {
        // b's implicit end is its own compress call — always before this one.
        const bEndIdx = findToolCallIndex(messages, b.compressCallId);
        const bStartIdx =
          b.startToolCallId === null
            ? firstUser >= 0
              ? firstUser + 1
              : -1
            : findToolCallIndex(messages, b.startToolCallId);
        if (bEndIdx < 0 || bStartIdx < 0) continue; // orphan block — the transform drops it
        const bLo = b.startToolCallId === null ? bStartIdx : bStartIdx + 1;
        if (bEndIdx < elideFrom) continue; // entirely before the new span — summaries accumulate
        // b's compress call falls inside the new span. b may only survive fully
        // contained — otherwise its summary injection point would be elided
        // while its span still applies (a dead, half-applied block).
        if (bLo < elideFrom) {
          throw new Error(
            `startAnchor "${startName}" lies inside the active compression from "${b.startName}" — compress from "${b.startName}" (or an earlier anchor) to absorb it, or place the startAnchor after it`,
          );
        }
        consumed.push(b); // fully contained — absorbed into the new summary
      }

      const block: CompressionBlock = {
        id: state.nextBlockId++,
        startName,
        startToolCallId: start.toolCallId,
        summary,
        compressCallId: toolCallId,
        createdAt: Date.now(),
      };
      if (consumed.length > 0) {
        const consumedIds = new Set(consumed.map((b) => b.id));
        state.blocks = state.blocks.filter((b) => !consumedIds.has(b.id));
      }
      state.blocks.push(block);
      state.dirty = true;
      persist();

      const elided = endIdx - elideFrom;
      logger.info("Compressed range", {
        blockId: block.id,
        from: startName,
        elidedMessages: elided,
        consumedBlocks: consumed.map((b) => b.id),
      });

      const absorbed = consumed.length > 0 ? ` Absorbed ${consumed.length} prior compression(s).` : "";
      return textResult(
        `Compressed from "${startName}" to this compress call (${elided} message(s) elided).${absorbed} The summary now replaces that span in your context, right before this compress call.`,
        { blockId: block.id, elidedMessages: elided, consumedBlockIds: consumed.map((b) => b.id) },
      );
    },
  };
}
