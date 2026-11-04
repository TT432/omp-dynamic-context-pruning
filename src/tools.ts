/**
 * The three DCP tools: add_anchor, compress, expand.
 *
 * Errors are reserved for calls that cannot mean anything — an unknown anchor,
 * a span with nothing in it, an unknown block id. Everything else (summary
 * shape, missing evidence pointers, a long line) comes back as an advisory in
 * the result: a rejection costs a turn and the model reads the same text
 * either way.
 */

import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, ToolResult } from "./omp";
import type { Logger } from "./logger";
import type { CompressionBlock, SessionState } from "./state";
import { ancestorsOf, findBlock } from "./state";
import {
  ADD_ANCHOR_TOOL,
  SESSION_START_ANCHOR,
  findToolCallIndex,
  firstUserMessageIndex,
  scanAnchors,
  type AnchorRef,
} from "./anchors";
import { ADD_ANCHOR_PROMPT, COMPRESS_PROMPT, EXPAND_PROMPT } from "./prompts";
import { formatProblems, gistOf, parseSummary } from "./summary";
import { latestUsageTokens } from "./remind";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("role" in value)) return false;
  return typeof value.role === "string";
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
        `Anchor "${name}" recorded here. Use it as startAnchor when you compress the stretch that follows. If you compress from an earlier anchor later in this same stretch, this anchor lies inside that span and disappears — so compress the finished unit first, then place the anchor for the next one.`,
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
    startAnchor: zod.string({
      description:
        'Live anchor where compression starts (it is consumed); "session_start" compresses from the original prompt. Anchors swallowed by an earlier compression are unusable.',
    }),
    summary: zod.string({
      description:
        "Plain Markdown string (never a JSON object or key-value map) — the only record of the span; original messages are not recoverable. Recommended slots, in order: ## 当前任务 / ## 已完成 / ## 未完成 / ## 约束 / ## 文件与命令 / ## 在跑作业与句柄; each fact a `- ` bullet ending in `证据: <定位>`. Shape is advisory: a summary that does not follow it is still applied, and cannot be amended afterwards.",
    }),
  });

  return {
    name: "compress",
    label: "Compress",
    description: COMPRESS_PROMPT,
    parameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const p = params as { startAnchor?: unknown; summary?: unknown };
      if (typeof p.startAnchor !== "string" || p.startAnchor.trim().length === 0) {
        throw new Error('compress requires a non-empty string "startAnchor"');
      }
      if (typeof p.summary !== "string" || p.summary.trim().length === 0) {
        throw new Error('compress requires a non-empty string "summary" — it is the only record future turns will have');
      }
      const startName = p.startAnchor.trim();
      const summary = p.summary;

      // Advisory only: shape problems ride the result, they never block the
      // compression (a rejection costs a turn and the model re-sends the same
      // draft anyway).
      const parsed = parseSummary(summary);

      const messages = branchMessages(ctx);
      if (messages.length === 0) {
        throw new Error("no session messages available to compress; try again on a later turn");
      }
      const anchors = scanAnchors(messages);
      const start = anchors.find((a) => a.name === startName);
      if (!start) {
        throw new Error(`unknown startAnchor "${startName}". Available anchors: ${anchorList(anchors)}`);
      }

      // The span's end is implicit: this compress call's position. The
      // in-flight call is usually not yet appended to the branch when execute
      // runs; it lands at the end, so fall back to messages.length.
      const callIdx = findToolCallIndex(messages, toolCallId);
      const endIdx = callIdx >= 0 ? callIdx : messages.length;

      // First whole-elided message index: for a real start the anchor message
      // is only stripped of its anchor block, so elision starts after it;
      // for session_start elision starts right after the first user message.
      const elideFrom = start.toolCallId === null ? start.msgIndex : start.msgIndex + 1;
      if (elideFrom >= endIdx) {
        throw new Error(`range from "${startName}" to this compress call contains no messages to compress`);
      }

      // Absorb every live block whose compress call falls inside the new span.
      // Its summary stays in state and is rendered as an index line under the
      // new block, so absorbing is loss-free and needs no merge validation.
      const absorbed: CompressionBlock[] = [];
      for (const b of state.blocks) {
        if (b.supersededBy !== null) continue;
        const bEndIdx = findToolCallIndex(messages, b.compressCallId);
        if (bEndIdx < 0 || bEndIdx < elideFrom) continue;
        absorbed.push(b);
      }

      // Anchors that sit inside the span are elided with it. The model cannot
      // see them afterwards (the reminder scans the transformed copy), so the
      // result has to say which names vanished — otherwise reusing one of them
      // later starts a span inside the old block and resurrects elided text.
      const swallowed = anchors.filter(
        (a) => a.toolCallId !== null && a.msgIndex >= elideFrom && a.msgIndex < endIdx,
      );

      const block: CompressionBlock = {
        id: state.nextBlockId++,
        startName,
        startToolCallId: start.toolCallId,
        summary,
        compressCallId: toolCallId,
        parentIds: absorbed.map((b) => b.id).sort((a, b) => b - a),
        supersededBy: null,
        createdAt: Date.now(),
      };
      for (const b of absorbed) b.supersededBy = block.id;
      state.blocks.push(block);
      // The newest usage report belongs to the pre-compression context; mark it
      // so the next estimate does not anchor on the size we just discarded.
      state.usageMark = latestUsageTokens(messages) ?? 0;
      state.dirty = true;
      persist();

      const elided = endIdx - elideFrom;
      logger.info("Compressed range", {
        blockId: block.id,
        from: startName,
        elidedMessages: elided,
        absorbedBlocks: absorbed.map((b) => b.id),
        problems: parsed.problems.length,
      });

      const chain = ancestorsOf(state.blocks, block);
      const absorbedNote =
        chain.length > 0
          ? ` Absorbed ${absorbed.length} prior block(s); the chain reaches back ${chain.length}: ${chain
              .map((b) => `块 ${b.id}「${b.startName}」${gistOf(b.summary, 60) || "(无摘要)"} — expand({block: ${b.id}})`)
              .join("；")}`
          : "";
      const swallowedNote =
        swallowed.length > 0
          ? ` Anchors swallowed by this span (now elided, not reusable): ${swallowed
              .map((a) => `"${a.name}"`)
              .join(", ")}. Do not pass them to compress again — place the next anchor after this call.`
          : "";
      return textResult(
        `Compressed from "${startName}" to this compress call (${elided} message(s) elided) as block ${block.id}.${absorbedNote}${swallowedNote} The summary now replaces that span in your context, right before this compress call.${formatProblems(parsed.problems)}`,
        {
          blockId: block.id,
          elidedMessages: elided,
          absorbedBlockIds: absorbed.map((b) => b.id),
          swallowedAnchors: swallowed.map((a) => a.name),
          problems: parsed.problems,
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

export interface ExpandToolDeps {
  state: SessionState;
  logger: Logger;
  zod: ExtensionAPI["zod"];
}

/** Render one block in full, plus its own index lines so the model can walk back. */
function renderExpanded(blocks: CompressionBlock[], block: CompressionBlock): string {
  const parents = ancestorsOf(blocks, block);
  const head = `[block ${block.id}「${block.startName}」 — 摘要全文；原始消息不可恢复]`;
  if (parents.length === 0) return `${head}\n${block.summary}`;
  const index = parents
    .map((a) => `- 块 ${a.id}「${a.startName}」：${gistOf(a.summary) || "(无摘要)"} — 摘要: expand({block: ${a.id}})`)
    .join("\n");
  return `${head}\n${block.summary}\n\n更深一层（索引）:\n${index}`;
}

export function createExpandTool(deps: ExpandToolDeps): ToolDefinition {
  const { state, logger, zod } = deps;
  const parameters = zod.object({
    block: zod.number({ description: "Compression block id, as listed under a newer summary's index lines" }),
  });

  return {
    name: "expand",
    label: "Expand block",
    description: EXPAND_PROMPT,
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<ToolResult> {
      const p = params as { block?: unknown };
      const id = typeof p.block === "number" ? p.block : Number(p.block);
      if (!Number.isFinite(id)) throw new Error('expand requires a numeric "block" id');
      const block = findBlock(state.blocks, id);
      if (!block) {
        const known = state.blocks.map((b) => b.id).join(", ") || "(none)";
        throw new Error(`unknown compression block ${id}. Known blocks: ${known}`);
      }
      logger.info("Expanded block", { blockId: id, supersededBy: block.supersededBy });
      return textResult(renderExpanded(state.blocks, block), { blockId: id, parentIds: block.parentIds });
    },
  };
}
