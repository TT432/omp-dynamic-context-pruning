/**
 * Anchor model — the heart of anchor-based compression.
 *
 * An anchor is a named position in the conversation:
 *   - a real anchor is an `add_anchor` tool call; its identity is the
 *     provider-assigned tool-call id (globally unique, persisted, never mutated);
 *   - `session_start` is a virtual anchor the plugin injects right after the
 *     first user message (the original prompt). It is never consumed.
 *
 * Message shape (verified against pi-mono packages/ai/src/types.ts — the
 * extension `context` event fires before convertToLlm): assistant messages
 * carry `{type:"toolCall", id, name, arguments}` blocks; tool results are
 * standalone `{role:"toolResult", toolCallId}` messages.
 *
 * In the omp harness, extension tools surface as xd:// devices invoked through
 * the built-in `write` tool, so an add_anchor call persists as
 * `write({path:"xd://add_anchor", content:"<json args>"})`. anchorNameOf
 * recognizes both the direct and the enveloped form.
 */

import type { AgentMessage, ContentBlock, ToolCallBlock } from "./omp";

export const SESSION_START_ANCHOR = "session_start";
export const ADD_ANCHOR_TOOL = "add_anchor";

/** xd:// device invocation envelope used by the omp harness. */
const XD_WRITE_TOOL = "write";
const XD_ADD_ANCHOR_PATH = "xd://add_anchor";

export interface AnchorRef {
  name: string;
  /** tool-call id of the add_anchor call; null for the virtual session_start anchor. */
  toolCallId: string | null;
  /**
   * Index of the message containing the anchor call. For session_start, the
   * insertion point: firstUserIndex + 1 (no real message lives there).
   */
  msgIndex: number;
}

export function isToolCallBlock(block: ContentBlock): block is ToolCallBlock {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || block.type !== "toolCall") return false;
  if (!("id" in block) || typeof block.id !== "string") return false;
  if (!("name" in block) || typeof block.name !== "string") return false;
  if (!("arguments" in block) || typeof block.arguments !== "object" || block.arguments === null) return false;
  return true;
}

/** Thinking blocks carry no standalone content — a message reduced to them is "empty" to providers. */
export function isThinkingBlock(block: ContentBlock): boolean {
  if (typeof block !== "object" || block === null || !("type" in block)) return false;
  return block.type === "thinking" || block.type === "redacted_thinking";
}

/** Anchor name from a parsed args object: `anchor` key, or a lone string value (models sometimes guess "name"). */
function readAnchorArg(args: Record<string, unknown>): string | null {
  const direct = args.anchor;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const strings = Object.values(args).filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return strings.length === 1 ? strings[0].trim() : null;
}

/** Parse the xd envelope's `content` payload (a JSON string, or already an object). */
function parseContentJson(content: unknown): Record<string, unknown> | null {
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    // Already an object; property reads below are guarded.
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed content is not an anchor */
  }
  return null;
}

/** The anchor name carried by an add_anchor toolCall block (direct or xd-enveloped), or null. */
export function anchorNameOf(block: ContentBlock): string | null {
  if (!isToolCallBlock(block)) return null;
  if (block.name === ADD_ANCHOR_TOOL) return readAnchorArg(block.arguments);
  if (block.name === XD_WRITE_TOOL) {
    const path = block.arguments.path;
    if (typeof path !== "string" || path.trim() !== XD_ADD_ANCHOR_PATH) return null;
    const payload = parseContentJson(block.arguments.content);
    return payload === null ? null : readAnchorArg(payload);
  }
  return null;
}

/** Index of the original user prompt. toolResult is its own role, so role suffices. */
export function firstUserMessageIndex(messages: AgentMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Scan anchors in message order. The virtual session_start anchor comes first
 * (when a user prompt exists). Duplicate names should not occur (add_anchor
 * rejects them); the first occurrence wins.
 */
export function scanAnchors(messages: AgentMessage[]): AnchorRef[] {
  const anchors: AnchorRef[] = [];
  const firstUser = firstUserMessageIndex(messages);
  if (firstUser >= 0) {
    anchors.push({ name: SESSION_START_ANCHOR, toolCallId: null, msgIndex: firstUser + 1 });
  }
  const seen = new Set<string>([SESSION_START_ANCHOR]);
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const name = anchorNameOf(block);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      anchors.push({ name, toolCallId: (block as ToolCallBlock).id, msgIndex: i });
    }
  }
  return anchors;
}

/** Locate the message index containing a toolCall with the given id, or -1. */
export function findToolCallIndex(messages: AgentMessage[], toolCallId: string): number {
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isToolCallBlock(block) && block.id === toolCallId) return i;
    }
  }
  return -1;
}
