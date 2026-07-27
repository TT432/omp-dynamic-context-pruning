/**
 * Anchor model — the heart of anchor-based compression.
 *
 * An anchor is a named position in the conversation:
 *   - a real anchor is an `add_anchor` tool call; its identity is the
 *     provider-assigned tool_use id (globally unique, persisted, never mutated);
 *   - `session_start` is a virtual anchor the plugin injects right after the
 *     first user message (the original prompt). It is never consumed.
 *
 * Anchors are resolved by scanning the message array — no content signatures,
 * no ambiguity: names are unique per session (enforced by the add_anchor tool).
 */

import type { AgentMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from "./omp";

export const SESSION_START_ANCHOR = "session_start";
export const ADD_ANCHOR_TOOL = "add_anchor";

export interface AnchorRef {
  name: string;
  /** tool_use id of the add_anchor call; null for the virtual session_start anchor. */
  toolUseId: string | null;
  /**
   * Index of the message containing the anchor call. For session_start, the
   * insertion point: firstUserIndex + 1 (no real message lives there).
   */
  msgIndex: number;
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || block.type !== "tool_use") return false;
  if (!("id" in block) || typeof block.id !== "string") return false;
  return true;
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || block.type !== "tool_result") return false;
  if (!("tool_use_id" in block) || typeof block.tool_use_id !== "string") return false;
  return true;
}

/** The anchor name carried by an add_anchor tool_use block, or null. */
export function anchorNameOf(block: ContentBlock): string | null {
  if (!isToolUseBlock(block) || block.name !== ADD_ANCHOR_TOOL) return null;
  const input: unknown = block.input;
  if (typeof input !== "object" || input === null) return null;
  if (!("anchor" in input) || typeof input.anchor !== "string") return null;
  const name = input.anchor.trim();
  return name.length > 0 ? name : null;
}

/** Index of the original user prompt: first user message that is not tool results. */
export function firstUserMessageIndex(messages: AgentMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (m.content.some(isToolResultBlock)) continue;
    return i;
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
    anchors.push({ name: SESSION_START_ANCHOR, toolUseId: null, msgIndex: firstUser + 1 });
  }
  const seen = new Set<string>([SESSION_START_ANCHOR]);
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const name = anchorNameOf(block);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      anchors.push({ name, toolUseId: (block as ToolUseBlock).id, msgIndex: i });
    }
  }
  return anchors;
}

/** Locate the message index containing a tool_use with the given id, or -1. */
export function findToolUseIndex(messages: AgentMessage[], toolUseId: string): number {
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isToolUseBlock(block) && block.id === toolUseId) return i;
    }
  }
  return -1;
}

