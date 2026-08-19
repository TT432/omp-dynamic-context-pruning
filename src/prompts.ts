/**
 * Tool descriptions and message formats. Plain-text constants — no system
 * prompt injection; the tool list itself carries the usage contract.
 */

/** add_anchor tool description. */
export const ADD_ANCHOR_PROMPT = `Place a named anchor at this point in the conversation. Anchors are stable bookmarks used by the compress tool: compress(startAnchor, summary) replaces everything from the anchor up to the compress call with your summary. Drop an anchor whenever a stretch of work concludes so you can compress it later. A virtual anchor "session_start" always exists right after the original user prompt. Anchor names must be unique within the session; "session_start" is reserved.`;

/** compress tool description. */
export const COMPRESS_PROMPT = `Replace everything from a start anchor up to this compress call with a technical summary you author, reclaiming context. startAnchor is a name placed earlier with add_anchor, or "session_start" for the point right after the original user prompt. The end of the compressed span is implicit: this compress call itself.

Semantics: everything after the start anchor up to this compress call is replaced by your summary, which appears right before the compress call; the compress call and its confirmation stay in your context, so later turns can see the compression happened. The start anchor is consumed. Earlier compressions whose compress call lies before the start anchor stay in place — their summaries and yours accumulate in order. A span that reaches back across a prior compression absorbs it entirely, so carry its key points into your new summary.

Write summaries that fully preserve decisions, code changes, file paths, and outcomes — they are the only record future turns will have of the compressed span. Never compress content you still need verbatim. Errors (unknown anchor, empty range, start anchor inside an active compression) change nothing. Session history is never modified — compression only reshapes what is sent to you.`;

/** Marker injected after the first user message: the virtual session_start anchor. */
export const SESSION_START_MARKER = `[anchor: session_start — compression origin; cite it as startAnchor to compress from the beginning of the session]`;

/** Human-facing summary header injected where a compressed span used to be. */
export function formatCompressedSummary(startName: string, summary: string): string {
  return `[Compressed: ${startName} → here]\n${summary}`;
}
