/**
 * Tool descriptions and message formats. Plain-text constants — no system
 * prompt injection; the tool list itself carries the usage contract.
 */

/** add_anchor tool description. */
export const ADD_ANCHOR_PROMPT = `Place a named anchor at this point in the conversation. Anchors are stable bookmarks used by the compress tool: compress(startAnchor, endAnchor, summary) replaces everything between two anchors with your summary. Drop an anchor whenever a stretch of work concludes so you can compress it later. A virtual anchor "session_start" always exists right after the original user prompt. Anchor names must be unique within the session; "session_start" is reserved.`;

/** compress tool description. */
export const COMPRESS_PROMPT = `Replace the conversation span between two anchors with a technical summary you author, reclaiming context. startAnchor / endAnchor are names placed earlier with add_anchor, or "session_start" for the point right after the original user prompt.

Semantics: everything from the start anchor (inclusive) up to the end anchor (exclusive) is replaced by your summary, which appears right after the end anchor; this compress call itself is hidden from future context. The start anchor is consumed; the end anchor survives — chain further compressions from it. Prior compressed spans fully inside the range are absorbed, so carry their key points into your new summary.

Write summaries that fully preserve decisions, code changes, file paths, and outcomes — they are the only record future turns will have of the compressed span. Never compress content you still need verbatim. Errors (unknown anchor, empty or reversed range, overlap with an active compression) change nothing. Session history is never modified — compression only reshapes what is sent to you.`;

/** Marker injected after the first user message: the virtual session_start anchor. */
export const SESSION_START_MARKER = `[anchor: session_start — compression origin; cite it as startAnchor to compress from the beginning of the session]`;

/** Human-facing summary header injected where a compressed span used to be. */
export function formatCompressedSummary(startName: string, endName: string, summary: string): string {
  return `[Compressed: ${startName} → ${endName}]\n${summary}`;
}
