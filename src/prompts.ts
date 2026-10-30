/**
 * Tool descriptions and message formats. Plain-text constants — no system
 * prompt injection; the tool list itself carries the usage contract.
 */

/** add_anchor tool description. */
export const ADD_ANCHOR_PROMPT = `Place a named anchor at this point in the conversation. Anchors are stable bookmarks used by the compress tool: compress(startAnchor, summary) replaces everything from the anchor up to the compress call with your summary. Drop an anchor whenever a stretch of work concludes so you can compress it later. A virtual anchor "session_start" always exists right after the original user prompt. Anchor names must be unique within the session; "session_start" is reserved.`;

/** compress tool description. */
export const COMPRESS_PROMPT = `Replace everything from a start anchor up to this compress call with a structured summary you author, reclaiming context. startAnchor is a name placed earlier with add_anchor, or "session_start" for the point right after the original user prompt. The end of the compressed span is implicit: this compress call itself.

Semantics: everything after the start anchor up to this compress call is replaced by your summary, which appears right before the compress call; the compress call and its confirmation stay in your context, so later turns can see the compression happened. The start anchor is consumed. Earlier compressions whose compress call lies before the start anchor stay in place — their summaries and yours accumulate in order. A span that reaches back across a prior compression absorbs it entirely, so carry its key points into your new summary. Errors (unknown anchor, empty range, start anchor inside an active compression) change nothing. Session history is never modified — compression only reshapes what is sent to you.

SUMMARY SHAPE — fixed slots, in this exact order and with these exact Chinese headers; a summary that does not match is rejected and nothing is compressed:

## 当前任务
- 正在做的事（必填，不能写「无」） 证据: <定位>
## 已完成
- 动作/结论 证据: <定位>
## 未完成
- 下一步的具体动作 证据: <定位>
## 约束
- 用户要求/不变量/禁忌 证据: <定位>
## 文件与命令
- 关键路径、入口、可复现命令 证据: <定位>
## 在跑作业与句柄
- 后台作业、子代理 id、服务端口 证据: <定位>

Rules: every slot appears exactly once, in that order; inside a slot each line starts with "- " and each fact ends with 证据: <locator>; a slot with nothing to report is a single "- 无". Facts are externalized — cite where the fact lives (path, file:line, session id, tool name, command) and do NOT paste原文, because the summary is the only record future turns will have and a paraphrase without a pointer cannot be re-checked later. Facts stay under 600 characters.

Full-session compression (startAnchor = "session_start") requires force=true: it discards all working context and is the known amnesia footgun. Only confirm when the current work unit is complete, and expect the strict tier — 已完成 and 未完成 must carry real content, and every 证据 must be a locatable pointer (path, file:line, session id, URI or command). That cost is deliberate: the more a summary throws away, the more it must prove.`;

/** Marker injected after the first user message: the virtual session_start anchor. */
export const SESSION_START_MARKER = `[anchor: session_start — compression origin; cite it as startAnchor to compress from the beginning of the session]`;

/** Human-facing summary header injected where a compressed span used to be. */
export function formatCompressedSummary(startName: string, summary: string): string {
  return `[Compressed: ${startName} → here]\n${summary}`;
}
