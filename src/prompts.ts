/**
 * Tool descriptions and message formats. Plain-text constants — no system
 * prompt injection; the tool list itself carries the usage contract.
 *
 * Design stance: the *prompt* is where the discipline lives. dcp does not
 * reject a summary for its shape (see summary.ts), so the description has to
 * state what a good summary is worth and why — the model is the only component
 * that can judge whether a fact deserves to survive.
 */

/** add_anchor tool description. */
export const ADD_ANCHOR_PROMPT = `Place a named anchor at this point in the conversation. Anchors are stable bookmarks used by the compress tool: compress(startAnchor, summary) replaces everything from the anchor up to the compress call with your summary. Drop an anchor whenever a stretch of work concludes so you can compress it later, then keep working from the new position — the anchor you just placed marks where the *next* span starts. A virtual anchor "session_start" always exists right after the original user prompt. Anchor names must be unique within the session; "session_start" is reserved.`;

/** compress tool description. */
export const COMPRESS_PROMPT = `Replace everything from a start anchor up to this compress call with a summary you author, reclaiming context. startAnchor is a name placed earlier with add_anchor, or "session_start" for the point right after the original user prompt. The end of the compressed span is implicit: this compress call itself.

Semantics: everything after the start anchor up to this compress call is replaced by your summary, which appears right before the compress call; the compress call and its confirmation stay in your context, so later turns can see the compression happened. The start anchor is consumed. Earlier compressions whose compress call lies before the start anchor stay in place — their summaries and yours accumulate in order. A span that reaches back across a prior compression absorbs it: the absorbed block is kept in dcp's own chain and listed under your summary as an index line, so its full text is one expand call away and nothing you leave out is destroyed.

No summary is ever rejected. Shape is a request, not a gate — but the summary is the only record of the span, so write it for the reader who has to continue the work:

Recommended shape (fixed slots, this order, these Chinese headers):
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

Rules worth following: each slot once, in order; each fact a "- " bullet ending in 证据: <定位> (path, file:line, session id, commit, URL, command) so the next turn can re-read the source instead of trusting a paraphrase; a slot with nothing to report is a single "- 无". Facts are pointers, not pastes — keep each line short enough to re-read.

Full-session compression (startAnchor = "session_start") discards all working context at once. It is fine now that absorbed blocks remain recallable, but it is still the most lossy call you can make: prefer compressing a span that ends at an anchor you placed after the work unit, and state in 当前任务 what the next turn should do first.`;

/** expand tool description. */
export const EXPAND_PROMPT = `Retrieve the full text of a compression block that is currently shown only as an index line under a newer summary, or re-read your own block. Compression blocks form a chain: a newer block absorbs older ones and lists them as one-line indexes (with a gist). Call expand with the block id from such an index line to get that block's whole summary — including its own index lines, so you can walk further back if the fact you need is older still. Use it when a detail you need was compressed away or looks wrong; the block text is the record dcp kept, so re-read it before re-deriving anything from scratch.`;

/** Marker injected after the first user message: the virtual session_start anchor. */
export const SESSION_START_MARKER = `[anchor: session_start — compression origin; cite it as startAnchor to compress from the beginning of the session]`;

export interface RenderedBlock {
  startName: string;
  id: number;
  summary: string;
  /** Ancestor index lines: block id, anchor name, gist. */
  ancestors: Array<{ id: number; startName: string; gist: string }>;
}

/**
 * Human-facing text injected where a compressed span used to be: the summary
 * in full, followed by an index of the blocks it absorbed. Ancestors are one
 * line each so the context cost stays bounded no matter how long the chain is.
 */
export function formatCompressedSummary(block: RenderedBlock): string {
  const head = `[Compressed: ${block.startName} → here] (block ${block.id})`;
  if (block.ancestors.length === 0) return `${head}\n${block.summary}`;
  const index = block.ancestors
    .map((a) => `- 块 ${a.id}「${a.startName}」：${a.gist || "(无摘要)"} — 全文: expand({block: ${a.id}})`)
    .join("\n");
  return `${head}\n${block.summary}\n\n已并入本块的旧压缩块（索引，全文未丢失）:\n${index}`;
}
