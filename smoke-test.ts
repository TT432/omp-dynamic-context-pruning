/**
 * Smoke test — exercises the anchor-based compression pipeline against
 * synthetic omp messages in the real pi-mono shape (verified against live
 * session transcripts): assistant messages carry `{type:"toolCall", id, name,
 * arguments}` blocks; tool results are standalone `{role:"toolResult",
 * toolCallId}` messages. Extension tools invoked via the xd:// envelope
 * (`write({path:"xd://add_anchor", content:"<json>"})`) are covered too.
 *
 * compress semantics under test: compress(startAnchor, summary) elides the
 * span from the anchor up to the compress call itself — the end is implicit,
 * there is no endAnchor. Absorbed blocks form a chain: their text stays in
 * state, renders as an index line, and comes back in full through `expand`.
 * Nothing about a summary is rejected; shape problems ride the result.
 *
 * Run: bun smoke-test.ts
 */
import { scanAnchors, firstUserMessageIndex } from "./src/anchors";
import { applyCompressions, renderBlock } from "./src/transform";
import { createAddAnchorTool, createCompressTool, createExpandTool, branchMessages } from "./src/tools";
import {
  createSessionState,
  saveSessionState,
  loadSessionState,
  PERSIST_TYPE,
} from "./src/state";
import {
  bindSession,
  createContextHandler,
  createSessionCompactHandler,
  resolveSessionId,
  type HandlerDeps,
} from "./src/hooks";
import {
  estimateContextTokens,
  maybeAppendReminder,
  REMIND_MARKER,
  UNIT_MARKER,
  parseRemindPolicy,
  DEFAULT_TOKEN_THRESHOLD,
  tokenBracket,
  finishedTodoSet,
  type RemindCursor,
} from "./src/remind";
import { Logger } from "./src/logger";
import { parseSummary } from "./src/summary";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, ToolResult } from "./src/omp";

const logger = new Logger(false);
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}
/** Reminder policy with only the token trigger active. */
function tok(tokenThreshold: number) {
  return { tokenThreshold };
}
const REMIND_OFF = tok(0);

async function assertThrows(fn: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    assert(false, `${msg} — should have thrown`);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert(pattern.test(text), `${msg} — threw /${pattern.source}/ (got: ${text.slice(0, 90)})`);
  }
}

// ---------------------------------------------------------------------------
// synthetic conversation helpers (pi-mono shape)
// ---------------------------------------------------------------------------
function txt(t: string) {
  return { type: "text", text: t };
}
function tu(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}
/** Tool result: a standalone message in pi-mono shape. */
function tres(id: string, name: string, text: string): AgentMessage {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [txt(text)], isError: false };
}
function anchorCall(id: string, name: string) {
  return tu(id, "add_anchor", { anchor: name });
}
/** xd:// envelope as produced by the omp harness for extension tools. */
function xdAnchorCall(id: string, jsonArgs: string) {
  return tu(id, "write", { path: "xd://add_anchor", content: jsonArgs, i: "添加压缩锚点" });
}

/** Text of the first content block of a tool result, or "". */
function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (typeof block !== "object" || block === null || !("text" in block)) return "";
  return typeof block.text === "string" ? block.text : "";
}

/** Text of the first content block of a message, or "". */
function firstText(message: AgentMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const block = content[0];
  if (typeof block !== "object" || block === null || !("text" in block)) return "";
  return typeof block.text === "string" ? block.text : "";
}

/** Recommended slot order of the summary shape (mirrors src/summary.ts). */
const SLOTS = ["当前任务", "已完成", "未完成", "约束", "文件与命令", "在跑作业与句柄"];

/** A slot-structured summary; `marker` lands in every slot's fact. */
function sum(marker: string, overrides: Partial<Record<string, string>> = {}): string {
  const fact = (slot: string) => overrides[slot] ?? `${marker} — ${slot}`;
  return SLOTS.map((slot) => `## ${slot}\n- ${fact(slot)} 证据: smoke-test.ts:1`).join("\n");
}

function entriesOf(messages: AgentMessage[]): SessionEntry[] {
  return messages.map((m, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i > 0 ? `e${i - 1}` : null,
    timestamp: new Date().toISOString(),
    message: m,
  }));
}

function makeCtx(messages: AgentMessage[], sessionId = "sess-1"): ExtensionContext {
  const branch = entriesOf(messages);
  return {
    ui: { notify() {} },
    hasUI: false,
    cwd: ".",
    isIdle: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => "/tmp/sess.jsonl",
      getSessionId: () => sessionId,
    },
  };
}

/**
 * Minimal zod-like schema. Methods are chainable and `.optional()` is an
 * instance method — the host zod has no top-level `optional` (verified
 * 2026-10-07, tools.ts uses `schema.optional()`).
 */
type StubSchema = Record<string, unknown> & {
  optional: () => StubSchema;
  describe: (text: string) => StubSchema;
  min: (n: number) => StubSchema;
};
function stubSchema(extra: Record<string, unknown> = {}): StubSchema {
  const schema: StubSchema = { ...extra, optional: () => schema, describe: () => schema, min: () => schema };
  return schema;
}
const zodStub = {
  object: (shape: unknown) => stubSchema({ shape }),
  string: () => stubSchema(),
  boolean: () => stubSchema(),
  number: () => stubSchema(),
  array: (item: unknown) => stubSchema({ item }),
  enum: (values: unknown) => stubSchema({ values }),
} as unknown as ExtensionAPI["zod"];

function makePi(appended: { customType: string; data: unknown }[]): ExtensionAPI {
  return {
    zod: zodStub,
    setLabel() {},
    on() {},
    registerTool() {},
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    pi: {},
  };
}

/**
 * Base conversation (indices matter — assertions reference them):
 *  0 user       "Build a demo app."                       ← original prompt
 *  1 assistant  text + bash tu_w1
 *  2 toolResult tu_w1
 *  3 assistant  "Marking a1." + add_anchor(a1) tu_a1      ← start anchor (with text)
 *  4 toolResult tu_a1
 *  5 assistant  "Working on feature X." + write tu_w2
 *  6 toolResult tu_w2
 *  7 assistant  "Feature X done." + bash tu_w3
 *  8 toolResult tu_w3
 *  9 assistant  compress tu_c1 {startAnchor:"a1"}          ← implicit end of the span
 * 10 toolResult tu_c1
 */
function convo(): AgentMessage[] {
  return [
    { role: "user", content: [txt("Build a demo app.")] },
    { role: "assistant", content: [txt("I'll start."), tu("tu_w1", "bash", { command: "ls" })] },
    tres("tu_w1", "bash", "file1 file2"),
    { role: "assistant", content: [txt("Marking a1."), anchorCall("tu_a1", "a1")] },
    tres("tu_a1", "add_anchor", 'Anchor "a1" recorded.'),
    { role: "assistant", content: [txt("Working on feature X."), tu("tu_w2", "write", { path: "x.ts" })] },
    tres("tu_w2", "write", "ok"),
    { role: "assistant", content: [txt("Feature X done."), tu("tu_w3", "bash", { command: "test" })] },
    tres("tu_w3", "bash", "pass"),
    { role: "assistant", content: [tu("tu_c1", "compress", { startAnchor: "a1", summary: "D1" })] },
    tres("tu_c1", "compress", "Compressed from a1"),
  ];
}

function clone(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => structuredClone(b)) : m.content }));
}

const state = createSessionState();
const addAnchorTool = createAddAnchorTool({ logger, zod: zodStub });
const appended: { customType: string; data: unknown }[] = [];
const pi = makePi(appended);
const compressTool = createCompressTool({
  state,
  logger,
  zod: zodStub,
  persist: () => saveSessionState(pi, state),
});

// ---------------------------------------------------------------------------
// 1. anchor scanning (direct form + xd:// envelope)
// ---------------------------------------------------------------------------
{
  const anchors = scanAnchors(convo());
  assert(anchors.map((a) => a.name).join(",") === "session_start,a1", "scanAnchors finds session_start + named anchors in order");
  assert(anchors[0].toolCallId === null && anchors[0].msgIndex === 1, "session_start is virtual, inserted after the prompt");
  assert(anchors[1].toolCallId === "tu_a1" && anchors[1].msgIndex === 3, "a1 resolves to its tool-call id and message index");
  assert(firstUserMessageIndex(convo()) === 0, "first user message is the prompt");
  const weird: AgentMessage[] = [tres("tu_z", "bash", "x"), { role: "user", content: [txt("real prompt")] }];
  assert(firstUserMessageIndex(weird) === 1, "toolResult message is not the original prompt");

  // xd:// envelope: anchor name inside the content JSON ("anchor" key and the
  // single-string fallback for models guessing "name")
  const env: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [xdAnchorCall("w1", '{"anchor":"x1"}')] },
    tres("w1", "write", "Anchor recorded"),
    { role: "assistant", content: [xdAnchorCall("w2", '{"name":"x2"}')] },
    tres("w2", "write", "Anchor recorded"),
    { role: "assistant", content: [tu("w3", "write", { path: "xd://compress", content: '{"startAnchor":"x1","summary":"s"}' })] },
    { role: "assistant", content: [tu("w4", "write", { path: "src/foo.ts", content: "code" })] },
  ];
  const envAnchors = scanAnchors(env);
  assert(
    envAnchors.map((a) => `${a.name}@${a.toolCallId}`).join(",") === "session_start@null,x1@w1,x2@w2",
    "xd:// envelope anchors resolve (anchor key + single-string fallback); compress envelope and plain writes ignored",
  );
}

// ---------------------------------------------------------------------------
// 2. add_anchor tool
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx(convo().slice(0, 3));
  const res = await addAnchorTool.execute("tu_new", { anchor: "fresh" }, undefined, undefined, ctx);
  assert(textOf(res).includes('Anchor "fresh" recorded'), "add_anchor confirms with the anchor name");
  assert(textOf(res).includes("NEXT span"), "add_anchor states that the anchor marks the next span's start");

  await assertThrows(
    () => addAnchorTool.execute("tu_other", { anchor: "a1" }, undefined, undefined, makeCtx(convo())),
    /already exists/,
    "add_anchor rejects a duplicate name",
  );
  {
    // self-exclusion: the in-flight call itself is already on the branch
    const res2 = await addAnchorTool.execute("tu_a1", { anchor: "a1" }, undefined, undefined, makeCtx(convo()));
    assert(textOf(res2).includes("recorded"), "add_anchor excludes its own call from the duplicate check");
  }
  await assertThrows(
    () => addAnchorTool.execute("tu_r", { anchor: "session_start" }, undefined, undefined, ctx),
    /reserved/,
    "add_anchor rejects the reserved session_start name",
  );
  await assertThrows(
    () => addAnchorTool.execute("tu_w", { anchor: "a b" }, undefined, undefined, ctx),
    /whitespace/,
    "add_anchor rejects whitespace in names",
  );
  await assertThrows(
    () => addAnchorTool.execute("tu_e", { anchor: "  " }, undefined, undefined, ctx),
    /must not be empty/,
    "add_anchor rejects empty names",
  );
}

// ---------------------------------------------------------------------------
// 3. compress happy path + transform (implicit end = the compress call)
// ---------------------------------------------------------------------------
{
  const before = appended.length;
  // in-flight timing: the compress call is not yet on the branch → end falls
  // back to the end of history
  const res = await compressTool.execute(
    "tu_c1",
    { startAnchor: "a1", summary: sum("D1: built feature X in x.ts") },
    undefined,
    undefined,
    makeCtx(convo().slice(0, 9)),
  );
  assert(state.blocks.length === 1, "compress records one block");
  const b = state.blocks[0];
  assert(
    b.startName === "a1" && b.startToolCallId === "tu_a1" && b.compressCallId === "tu_c1",
    "block stores the start anchor, its tool-call id, and the compress call id (no end anchor)",
  );
  assert(!("endName" in b) && !("endToolCallId" in b), "block carries no end-anchor fields");
  assert(b.parentIds.length === 0 && b.supersededBy === null, "first block is a chain root and stays live");
  assert(state.dirty === false, "compress persists immediately (dirty cleared)");
  assert(appended.length === before + 1 && appended[before].customType === PERSIST_TYPE, "compress appended a dcp-state entry");
  assert(textOf(res).includes('Compressed from "a1" to this compress call'), "compress result confirms the range");
  assert(textOf(res).includes("5 message(s) elided"), "elided count spans from after the anchor to the compress call");
  assert(!textOf(res).includes("摘要形状提示"), "a well-shaped summary produces no advisory");

  // same result when the in-flight call IS already on the branch
  const s3b = createSessionState();
  const tool3b = createCompressTool({ state: s3b, logger, zod: zodStub, persist: () => {} });
  const res3b = await tool3b.execute("tu_c1", { startAnchor: "a1", summary: sum("x") }, undefined, undefined, makeCtx(convo()));
  assert(textOf(res3b).includes("5 message(s) elided"), "compress call already on the branch resolves to the same end");

  // out = [prompt, MARKER, msg1, msg2, SUMMARY, msg9, msg10]
  // (msg3 is dropped outright: stripping the start anchor leaves it call-less)
  const out = applyCompressions(state, logger, clone(convo()));
  const render = JSON.stringify(out);
  assert(out.length === 7, `transform elides 5 + drops the call-less start message, injects marker + summary, keeps the compress pair (got ${out.length})`);
  assert(JSON.stringify(out[1]).includes("session_start"), "session_start marker sits right after the prompt");
  assert(!render.includes("Marking a1."), "start anchor message dropped entirely once call-less (stall-loop guard)");
  assert(!render.includes("tu_a1"), "start anchor toolCall stripped (anchor consumed)");
  assert(!render.includes("Working on feature X."), "span content elided");
  assert(!render.includes("Feature X done."), "span tail elided — the span runs up to the compress call");
  assert(!render.includes('Anchor \\"a1\\" recorded'), "start anchor toolResult elided");
  assert(render.includes("[Compressed: a1 → here]") && render.includes("D1: built feature X"), "summary injected with header");
  assert(render.includes("(block 1)"), "injected header names the block id (expand target)");
  assert(render.includes("tu_c1"), "compress call kept in context (it is the implicit end)");
  assert(JSON.stringify(out[4]).includes("[Compressed: a1 → here]"), "summary takes the place of the elided span");
  assert(JSON.stringify(out[5]).includes("tu_c1") && JSON.stringify(out[6]).includes("tu_c1"), "compress call and its confirmation follow the summary");
  assert(convo().length === 11 && !JSON.stringify(convo()).includes("[Compressed"), "transform never mutates the source conversation");
}

// ---------------------------------------------------------------------------
// 4. accumulation: a later compress from an anchor placed after an earlier
//    compress call keeps both blocks; summaries accumulate in order
// ---------------------------------------------------------------------------
{
  const extended: AgentMessage[] = [
    ...convo(),
    { role: "assistant", content: [txt("Second phase."), tu("tu_w4", "bash", { command: "test" })] },
    tres("tu_w4", "bash", "pass"),
    { role: "assistant", content: [anchorCall("tu_a2", "a2")] },
    tres("tu_a2", "add_anchor", 'Anchor "a2" recorded.'),
    { role: "assistant", content: [tu("tu_c2", "compress", { startAnchor: "a2", summary: "D2" })] },
    tres("tu_c2", "compress", "ok"),
  ];
  const res = await compressTool.execute(
    "tu_c2",
    { startAnchor: "a2", summary: sum("D2: phase two, tests pass") },
    undefined,
    undefined,
    makeCtx(extended.slice(0, 15)),
  );
  assert(state.blocks.length === 2 && state.blocks[0].id === 1 && state.blocks[1].id === 2, "second compress keeps the earlier block — summaries accumulate");
  assert(state.blocks[0].supersededBy === null, "an out-of-span block is not absorbed");
  assert(!textOf(res).includes("Absorbed"), "accumulation absorbs nothing");

  // out = [prompt, MARKER, msg1, msg2, SUMMARY1, msg9, msg10, msg11, msg12, SUMMARY2, msg15, msg16]
  // (msg3 and msg13 are dropped outright: stripping leaves both call-less;
  //  msg14 falls inside block2's span and is elided with it)
  const out = applyCompressions(state, logger, clone(extended));
  const render = JSON.stringify(out);
  assert(out.length === 12, `both summaries + both compress pairs survive (got ${out.length})`);
  assert(render.includes("D1: built feature X"), "earlier summary stays in place");
  assert(render.includes("D2: phase two"), "new summary injected");
  assert(render.indexOf("D1: built feature X") < render.indexOf("D2: phase two"), "summaries accumulate in order");
  assert(!render.includes("已并入本块"), "no chain index when nothing was absorbed");
  assert(render.includes("tu_c1"), "earlier compress call kept — it sits before the new span");
  assert(render.includes("Second phase."), "work between the two compressions kept");
  assert(!render.includes("tu_a2"), "new start anchor stripped (consumed)");
  assert(!render.includes('Anchor \\"a2\\" recorded'), "new start anchor toolResult elided with the span");
  assert(render.includes("tu_c2"), "new compress call kept in context");
}

// ---------------------------------------------------------------------------
// 5. session_start as start anchor (no confirmation flag — absorbed blocks stay
//    recallable, so the full wipe is no longer unrecoverable)
// ---------------------------------------------------------------------------
{
  const s2 = createSessionState();
  const tool2 = createCompressTool({ state: s2, logger, zod: zodStub, persist: () => {} });
  const mini: AgentMessage[] = [
    { role: "user", content: [txt("Original prompt.")] },
    { role: "assistant", content: [tu("tu_x1", "bash", { command: "ls" })] },
    tres("tu_x1", "bash", "files"),
    { role: "assistant", content: [anchorCall("tu_b1", "b1")] },
    tres("tu_b1", "add_anchor", "ok"),
    { role: "assistant", content: [tu("tu_c3", "compress", { startAnchor: "session_start", summary: "DS" })] },
    tres("tu_c3", "compress", "ok"),
  ];
  await tool2.execute("tu_c3", { startAnchor: "session_start", summary: sum("DS: early exploration done.") }, undefined, undefined, makeCtx(mini.slice(0, 5)));
  assert(s2.blocks.length === 1 && s2.blocks[0].startToolCallId === null, "session_start block stores a null startToolCallId");

  // out = [prompt, MARKER, SUMMARY, compress(tu_c3), tr_c3]
  const out = applyCompressions(s2, logger, clone(mini));
  const render = JSON.stringify(out);
  assert(out.length === 5, `session_start compression keeps prompt + marker + summary + compress pair (got ${out.length})`);
  assert(render.includes("Original prompt."), "original prompt preserved");
  assert(render.includes("[anchor: session_start"), "session_start marker preserved (never consumed)");
  assert(!render.includes("tu_x1"), "post-prompt span elided");
  assert(!render.includes("tu_b1"), "anchor inside the span elided with it");
  assert(JSON.stringify(out[2]).includes("[Compressed: session_start → here]"), "summary before the compress call, header cites session_start");
  assert(JSON.stringify(out[3]).includes("tu_c3"), "compress call follows the summary");
}

// ---------------------------------------------------------------------------
// 6. nothing about a summary is rejected: shape problems are advisory and the
//    compression still applies. Only meaningless calls throw (unknown anchor,
//    empty span, empty summary) — each of those leaves state untouched.
// ---------------------------------------------------------------------------
{
  const mk = () => {
    const st = createSessionState();
    return { st, tool: createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} }) };
  };
  const ctx = makeCtx(convo().slice(0, 9));

  // preconditions still throw
  await assertThrows(
    () => mk().tool.execute("tu_e1", { startAnchor: "nope", summary: sum("x") }, undefined, undefined, ctx),
    /unknown startAnchor "nope".*session_start/s,
    "unknown startAnchor throws, available anchors listed",
  );
  await assertThrows(
    () => mk().tool.execute("tu_e2", { startAnchor: "a1", summary: "  " }, undefined, undefined, ctx),
    /non-empty string "summary"/,
    "empty summary throws",
  );
  const adjacent: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [anchorCall("tu_p1", "p1")] },
  ];
  await assertThrows(
    () => mk().tool.execute("tu_e3", { startAnchor: "p1", summary: sum("x") }, undefined, undefined, makeCtx(adjacent)),
    /contains no messages/,
    "empty range throws (anchor immediately precedes the compress call)",
  );

  // a shape-less prose summary compresses anyway, with the advisory attached
  {
    const { st, tool } = mk();
    const prose = "先做了摸底，然后改了 x.ts，测试通过，下一步跑 1.20.1。";
    const res = await tool.execute("tu_c1", { startAnchor: "a1", summary: prose }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary === prose, "free-form summary is applied, not rejected");
    assert(textOf(res).includes("摘要形状提示"), "advisory names the shape deviation");
    assert(textOf(res).includes("当前任务"), "advisory restates the recommended slots");
    assert(st.nextBlockId === 2, "block id counter advanced");
  }

  // a summary with a broken slot header still applies and still renders
  {
    const { st, tool } = mk();
    const res = await tool.execute(
      "tu_c1",
      { startAnchor: "a1", summary: "## 任务（本轮）\n- 改 x.ts 证据: x.ts:1\n## 已完成\n- 做完 证据: x.ts:2" },
      undefined,
      undefined,
      ctx,
    );
    assert(st.blocks.length === 1, "unknown slot header does not block the compress");
    assert(textOf(res).includes("不在建议列表"), "advisory reports the unknown slot");
    assert(renderBlock(st.blocks, st.blocks[0]).summary.includes("## 任务（本轮）"), "the model's own headers are preserved verbatim");
  }
}

// ---------------------------------------------------------------------------
// 7. persistence round trip (v5 chain fields) + v4 migration + older ignored
// ---------------------------------------------------------------------------
{
  const s5 = createSessionState();
  s5.sessionId = "sess-persist";
  s5.blocks.push({
    id: 7,
    startName: "a1",
    startToolCallId: "tu_a1",
    summary: "S",
    compressCallId: "tu_c",
    parentIds: [5, 4],
    supersededBy: 8,
    createdAt: 123,
  });
  s5.nextBlockId = 8;
  s5.usageMark = 900;
  s5.unitRemindId = "tu_todo7";
  s5.dirty = true;
  const app: { customType: string; data: unknown }[] = [];
  saveSessionState(makePi(app), s5);
  assert(app.length === 1 && (s5.dirty as boolean) === false, "save appends one entry and clears dirty");

  const branch: SessionEntry[] = [
    { type: "custom", id: "c1", parentId: null, timestamp: new Date().toISOString(), customType: PERSIST_TYPE, data: app[0].data },
  ];
  const s6 = createSessionState();
  const loaded = loadSessionState(branch, s6);
  assert(loaded && s6.blocks.length === 1 && s6.blocks[0].id === 7 && s6.blocks[0].compressCallId === "tu_c", "round trip restores the block");
  assert(s6.nextBlockId === 8, "nextBlockId restored");
  assert(s6.blocks[0].parentIds.join(",") === "5,4" && s6.blocks[0].supersededBy === 8, "chain fields survive the round trip");
  assert(s6.usageMark === 900 && s6.unitRemindId === "tu_todo7", "reminder watermarks survive the round trip");
  assert(!("toolCallMark" in (app[0].data as Record<string, unknown>)), "the tool-call counter is gone from the persisted shape");

  // v4 (pre-chain) entries migrate: absorbed parents were already deleted, so
  // they come back as chain roots instead of being discarded
  const v4: SessionEntry[] = [
    {
      type: "custom",
      id: "c2",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: PERSIST_TYPE,
      data: {
        v: 4,
        sessionId: "sess-old",
        nextBlockId: 9,
        blocks: [{ id: 8, startName: "session_start", startToolCallId: null, summary: "old", compressCallId: "tu_old", createdAt: 5 }],
        usageMark: 0,
        remindLevel: 0,
      },
    },
  ];
  const s7 = createSessionState();
  assert(loadSessionState(v4, s7) === true && s7.blocks.length === 1, "v4 entry is migrated");
  assert(s7.blocks[0].parentIds.length === 0 && s7.blocks[0].supersededBy === null, "v4 block becomes a chain root");

  for (const v of [1, 2, 3]) {
    const oldBranch: SessionEntry[] = [
      { type: "custom", id: "c3", parentId: null, timestamp: new Date().toISOString(), customType: PERSIST_TYPE, data: { v, maps: {} } },
    ];
    const s8 = createSessionState();
    assert(loadSessionState(oldBranch, s8) === false && s8.blocks.length === 0, `v${v} entries are ignored`);
  }
}

// ---------------------------------------------------------------------------
// 8. lifecycle: bind loads state, compact clears + persists
// ---------------------------------------------------------------------------
{
  const s8 = createSessionState();
  const app8: { customType: string; data: unknown }[] = [];
  const pi8 = makePi(app8);
  const deps: HandlerDeps = { state: s8, logger, pi: pi8, remind: REMIND_OFF };

  const seeded = createSessionState();
  seeded.sessionId = "sess-life";
  seeded.blocks.push({
    id: 3, startName: "a", startToolCallId: "tu_a",
    summary: "seed", compressCallId: "tu_c", parentIds: [], supersededBy: null, createdAt: 1,
  });
  seeded.nextBlockId = 4;
  seeded.dirty = true;
  saveSessionState(pi8, seeded);

  const branch: SessionEntry[] = [
    { type: "custom", id: "c1", parentId: null, timestamp: new Date().toISOString(), customType: PERSIST_TYPE, data: app8[app8.length - 1].data },
  ];
  const ctx: ExtensionContext = {
    ui: { notify() {} },
    hasUI: false,
    cwd: ".",
    isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/x.jsonl", getSessionId: () => "sess-life" },
  };
  bindSession(deps, ctx, "test");
  assert(s8.sessionId === "sess-life" && s8.blocks.length === 1 && s8.blocks[0].id === 3, "bind loads persisted blocks");
  assert(s8.dirty === false, "bind leaves state clean");

  const compact = createSessionCompactHandler(deps);
  compact({ compactionEntry: { timestamp: new Date().toISOString() }, fromExtension: false }, ctx);
  assert(s8.blocks.length === 0, "session_compact clears blocks");
  assert(s8.lastCompaction > 0, "compaction timestamp tracked");
  assert(app8.length === 2, "compact persists the cleared state");

  assert(resolveSessionId(ctx) === "sess-life", "resolveSessionId prefers getSessionId");
  const fileOnly = makeCtx([], "");
  assert(resolveSessionId(fileOnly) === "/tmp/sess.jsonl", "resolveSessionId falls back to session file");
}

// ---------------------------------------------------------------------------
// 9. context handler end-to-end + orphan block cleanup
// ---------------------------------------------------------------------------
{
  const s9 = createSessionState();
  const tool9 = createCompressTool({ state: s9, logger, zod: zodStub, persist: () => {} });
  const msgs = convo();
  const deps9: HandlerDeps = { state: s9, logger, pi: makePi([]), remind: REMIND_OFF };
  // bind first — compress always happens on an already-bound session
  bindSession(deps9, makeCtx(msgs), "test");
  await tool9.execute("tu_c1", { startAnchor: "a1", summary: sum("D1 again.") }, undefined, undefined, makeCtx(msgs.slice(0, 9)));

  const handler = createContextHandler(deps9);
  const result = handler({ messages: clone(msgs) }, makeCtx(msgs));
  const render = JSON.stringify(result.messages);
  assert(render.includes("[anchor: session_start") && render.includes("D1 again.") && !render.includes("Working on feature X."), "context handler returns the transformed conversation");
  assert(s9.sessionId !== null, "context handler lazy-binds the session");

  // orphan: live block whose compress call no longer exists is dropped + dirty
  s9.blocks.push({
    id: 99, startName: "ghost", startToolCallId: "tu_g1",
    summary: "ghost", compressCallId: "tu_gone", parentIds: [], supersededBy: null, createdAt: 0,
  });
  s9.dirty = false;
  const out2 = applyCompressions(s9, logger, clone(msgs));
  assert(s9.blocks.length === 1 && (s9.dirty as boolean) === true, "orphan block dropped at transform time and marked dirty");
  assert(!JSON.stringify(out2).includes("ghost"), "orphan summary never injected");

  // a superseded block is text-only: it survives even when its own anchors are
  // gone, because expand still has to be able to return it
  s9.blocks.push({
    id: 100, startName: "dead", startToolCallId: "tu_d", summary: "kept text",
    compressCallId: "tu_c1", parentIds: [], supersededBy: 1, createdAt: 0,
  });
  applyCompressions(s9, logger, clone(msgs));
  assert(s9.blocks.some((b) => b.id === 100), "absorbed block keeps its text despite unresolvable anchors");
}

// ---------------------------------------------------------------------------
// 10. full pipeline through the xd:// envelope (the live failure mode)
// ---------------------------------------------------------------------------
{
  const s10 = createSessionState();
  const tool10 = createCompressTool({ state: s10, logger, zod: zodStub, persist: () => {} });
  // Mirrors the qylEyelib session: anchors added via write({path:"xd://add_anchor"})
  const live: AgentMessage[] = [
    { role: "user", content: [txt("整理 JE/BE 测试方法")] },
    { role: "assistant", content: [txt("先摸底。"), tu("tu_r1", "read", { path: "a.md" })] },
    tres("tu_r1", "read", "file a"),
    { role: "assistant", content: [xdAnchorCall("w1", '{"name": "reorg_done"}')] },
    tres("w1", "write", 'Anchor "reorg_done" recorded.'),
    { role: "assistant", content: [tu("tu_c9", "write", { path: "xd://compress", content: '{"startAnchor":"session_start","summary":"S"}' })] },
    tres("tu_c9", "write", "Compressed"),
  ];
  // the exact reported flow: compress right after the anchor was added
  const res = await tool10.execute(
    "tu_c9",
    { startAnchor: "session_start", summary: sum("S:摸底完成。") },
    undefined,
    undefined,
    makeCtx(live.slice(0, 5)),
  );
  assert(s10.blocks.length === 1 && s10.blocks[0].compressCallId === "tu_c9", "xd-enveloped compress resolves its own call as the span end");
  assert(textOf(res).includes('Compressed from "session_start"'), "compress confirms the enveloped range");

  const out = applyCompressions(s10, logger, clone(live));
  const render = JSON.stringify(out);
  assert(render.includes("S:摸底完成。"), "summary injected for enveloped block");
  assert(!render.includes("file a"), "span elided through the envelope");
  assert(render.includes("tu_c9"), "enveloped compress call kept as the span end");
}

// ---------------------------------------------------------------------------
// 11. provider validity: thinking-only shell drop + orphan toolCall guard
//     (the live HTTP 400: "assistant must not be empty")
// ---------------------------------------------------------------------------
{
  const s11 = createSessionState();
  const tool11 = createCompressTool({ state: s11, logger, zod: zodStub, persist: () => {} });
  const conv: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    // start anchor shares its message with a real bash call and a thinking block
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, anchorCall("t_a", "a"), tu("t_b", "bash", { command: "ls" })] },
    tres("t_a", "add_anchor", "ok"),
    tres("t_b", "bash", "files"),
    { role: "assistant", content: [txt("done"), tu("t_d", "bash", { command: "test" })] },
    tres("t_d", "bash", "pass"),
    // compress call accompanies a thinking block — the pair stays in context
    { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, tu("t_x", "compress", { startAnchor: "a", summary: "S" })] },
    tres("t_x", "compress", "ok"),
  ];
  await tool11.execute("t_x", { startAnchor: "a", summary: sum("S: done.") }, undefined, undefined, makeCtx(conv.slice(0, 6)));

  // out = [prompt, MARKER, SUMMARY, compress(t_x)+thinking, tres(t_x)]
  const out = applyCompressions(s11, logger, clone(conv));
  const render = JSON.stringify(out);
  assert(out.length === 5, `shell drop + orphan guard + kept compress pair (got ${out.length})`);
  assert(!render.includes("t_b"), "orphan guard strips the call whose toolResult was elided");
  assert(!render.includes("t_a"), "start anchor stripped");
  assert(!render.includes("hmm"), "thinking-only assistant shell dropped after stripping");
  assert(!render.includes("t_d"), "span tail elided up to the compress call");
  assert(render.includes("t_x") && render.includes("plan"), "compress call and its thinking block kept");
  assert(render.includes("S: done."), "summary injected");
  // every surviving toolCall has its toolResult in the output
  const ids = [...render.matchAll(/"id":"(t_[a-z])"/g)].map((m) => m[1]);
  assert(ids.every((id) => render.includes(`"toolCallId\":\"${id}"`) || render.includes(`"toolCallId":"${id}"`)), "no dangling toolCall without a toolResult");
}

// ---------------------------------------------------------------------------
// 12. branchMessages extraction
// ---------------------------------------------------------------------------
{
  const msgs = convo();
  const extracted = branchMessages(makeCtx(msgs));
  assert(extracted.length === msgs.length && extracted[0] === msgs[0], "branchMessages extracts message entries in order");
}

// ---------------------------------------------------------------------------
// 13. stall-loop guard: a message left with no tool calls after stripping is
//     dropped outright — even when it still has visible text. A surviving
//     text-only shell reads as an assistant turn that announces tool calls
//     and then stops ("开场三连：" → end of turn); the model imitates it and
//     stalls after every compress (live session 019fef18, 2026-08-13).
// ---------------------------------------------------------------------------
{
  const s13 = createSessionState();
  const tool13 = createCompressTool({ state: s13, logger, zod: zodStub, persist: () => {} });
  const conv: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    // work-unit opener: announcement text + anchor + todo + recon, one message
    { role: "assistant", content: [txt("开工。建 todo、放锚点、侦察："), anchorCall("t_a", "a"), tu("t_b", "todo", { op: "init" }), tu("t_c", "glob", { path: "src/**" })] },
    tres("t_a", "add_anchor", "ok"),
    tres("t_b", "todo", "ok"),
    tres("t_c", "glob", "src/a.ts"),
    { role: "assistant", content: [txt("done"), tu("t_d", "bash", { command: "test" })] },
    tres("t_d", "bash", "pass"),
    { role: "assistant", content: [tu("t_x", "compress", { startAnchor: "a", summary: "S" })] },
    tres("t_x", "compress", "ok"),
  ];
  await tool13.execute("t_x", { startAnchor: "a", summary: sum("S: done.") }, undefined, undefined, makeCtx(conv.slice(0, 7)));

  // out = [prompt, MARKER, SUMMARY, compress(t_x), tres(t_x)]
  const out = applyCompressions(s13, logger, clone(conv));
  const render = JSON.stringify(out);
  assert(!render.includes("开工"), "text-only announcement shell dropped after stripping (stall-loop guard)");
  assert(!render.includes("t_b") && !render.includes("t_c"), "orphan guard strips sibling calls whose results were elided");
  assert(!render.includes("t_d"), "span tail elided up to the compress call");
  assert(render.includes("t_x"), "compress call kept as the span end");
  assert(render.includes("S: done."), "summary injected");
}

// ---------------------------------------------------------------------------
// 14. over-threshold compress reminder (LLM-facing copy only, never persisted)
// ---------------------------------------------------------------------------
{
  const withWindow = (msgs: AgentMessage[], contextWindow?: number): ExtensionContext => ({
    ...makeCtx(msgs),
    model: contextWindow === undefined ? undefined : { id: "m", contextWindow },
  });
  const used = (totalTokens: number): AgentMessage => ({
    role: "assistant",
    content: [txt("turn done.")],
    usage: { input: totalTokens, output: 0, totalTokens },
  });

  // fraction of the model window: 900/1000 >= 0.8 → fires, names live anchors
  const msgs14 = convo();
  const hot = [...msgs14, used(900)];
  const out14 = maybeAppendReminder(hot, withWindow(hot, 1000), tok(0.8));
  const last14 = out14[out14.length - 1];
  const lastText = firstText(last14);
  assert(out14.length === hot.length + 1 && last14.role === "user", "reminder appended as a trailing user message over threshold");
  assert(lastText.includes(REMIND_MARKER) && lastText.includes("900"), "reminder reports the estimated tokens");
  assert(lastText.includes('"a1"') && lastText.includes('"session_start"'), "reminder lists the available anchors");
  assert(!/force=true|strict summary tier/.test(lastText), "reminder no longer demands the removed gates");

  // under threshold → same reference back, nothing appended
  const cool = [...convo(), used(500)];
  assert(maybeAppendReminder(cool, withWindow(cool, 1000), tok(0.8)) === cool, "no reminder under the threshold");

  // absolute token threshold; 0 disables even when far over
  assert(maybeAppendReminder(cool, withWindow(cool, 1000), tok(100)).length === cool.length + 1, "absolute token threshold fires");
  assert(maybeAppendReminder(hot, withWindow(hot, 1000), tok(0)) === hot, "threshold 0 disables the reminder");

  // fraction without a resolvable window → undeterminable, stay silent
  assert(maybeAppendReminder(hot, withWindow(hot), tok(0.8)) === hot, "no reminder when the window is unknown");
  // absolute threshold still works without a window
  assert(maybeAppendReminder(hot, withWindow(hot), tok(100)).length === hot.length + 1, "absolute threshold needs no window");

  // estimate: usage anchor + local tail; no usage → whole-conversation heuristic
  const tail = [...convo(), used(100), tres("tu_tail", "bash", "x".repeat(400))];
  assert(estimateContextTokens(tail) === 100 + Math.ceil(400 / 4), "estimate anchors on usage and counts the tail locally");
  const bigText: AgentMessage[] = [{ role: "user", content: [txt("y".repeat(4000))] }];
  assert(estimateContextTokens(bigText) === 1000, "estimate falls back to the chars/4 heuristic without usage");
  assert(maybeAppendReminder(bigText, withWindow(bigText, 1000), tok(0.8)).length === 2, "heuristic estimate can trigger the reminder");
  // CJK text tokenizes denser than ASCII: the same character count costs more
  const cjkText: AgentMessage[] = [{ role: "user", content: [txt("字".repeat(4000))] }];
  assert(estimateContextTokens(cjkText) === 2000, "CJK characters are counted at ~2 chars/token, not 4");

  // end-to-end through the context handler: reminder in the outgoing copy only
  const s14 = createSessionState();
  const deps14: HandlerDeps = { state: s14, logger, pi: makePi([]), remind: tok(0.8) };
  bindSession(deps14, makeCtx(hot), "test");
  const handled = createContextHandler(deps14)({ messages: clone(hot) }, withWindow(hot, 1000));
  assert(JSON.stringify(handled.messages[handled.messages.length - 1]).includes(REMIND_MARKER), "context handler appends the reminder");
  assert(!JSON.stringify(hot).includes(REMIND_MARKER), "stored messages never gain the reminder");
}

// ---------------------------------------------------------------------------
// 15. work-unit boundary reminder: fires once per finished todo set, on every
//     host wording, and never twice for the same result. The tool-call budget
//     is gone — a call count is not a context cost (session 01a19fdd compressed
//     at 40 calls, three minutes in, and re-read three files right after).
// ---------------------------------------------------------------------------
{
  const win = (msgs: AgentMessage[], contextWindow = 100000): ExtensionContext => ({
    ...makeCtx(msgs),
    model: { id: "m", contextWindow },
  });
  const withTodo = (text: string): AgentMessage[] => [
    ...convo(),
    { role: "assistant", content: [tu("td", "todo", { op: "done" })] },
    tres("td", "todo", text),
  ];
  const cursor = (): RemindCursor => ({ remindLevel: 0, unitRemindId: null });

  // every finished-set wording the host has emitted
  for (const wording of ["All items complete", "Remaining items (0)", "Remaining items: none.\nOverall: 4/4 done, 0 open."]) {
    const msgs = withTodo(wording);
    assert(finishedTodoSet(msgs) !== null, `finished todo set detected: ${wording.slice(0, 24)}`);
    const out = maybeAppendReminder(msgs, win(msgs), REMIND_OFF, 0, cursor());
    const text = firstText(out[out.length - 1]);
    assert(out.length === msgs.length + 1 && text.includes(UNIT_MARKER), `unit reminder appended: ${wording.slice(0, 24)}`);
    assert(text.includes('"a1"'), "unit reminder lists the available anchors");
    assert(!/force=true/.test(text), "unit reminder no longer demands force");
  }

  // mid-progress todo sets are not boundaries
  const wip = withTodo("Remaining items (2):\n- build\n- ship");
  assert(finishedTodoSet(wip) === null, "mid-progress todo set is not a boundary");
  assert(maybeAppendReminder(wip, win(wip), REMIND_OFF, 0, cursor()) === wip, "no unit reminder while the todo set is in progress");

  // dedupe: the same finished result never reminds twice
  const done = withTodo("Remaining items: none.");
  const c1 = cursor();
  const first = maybeAppendReminder(done, win(done), REMIND_OFF, 0, c1);
  assert(first.length === done.length + 1 && c1.unitRemindId === "td", "first sighting reports and records the watermark");
  assert(maybeAppendReminder(done, win(done), REMIND_OFF, 0, c1) === done, "same finished todo result stays silent");
  // a new finished result reports again
  const done2: AgentMessage[] = [...done, { role: "assistant", content: [tu("td2", "todo", { op: "done" })] }, tres("td2", "todo", "All items complete")];
  assert(maybeAppendReminder(done2, win(done2), REMIND_OFF, 0, c1).length === done2.length + 1, "a new finished result reports again");

  // one reminder per request; token pressure outranks the unit boundary
  const hotDone = [...done, { role: "assistant", content: [txt("turn")], usage: { input: 900, output: 0, totalTokens: 900 } }];
  const hotOut = maybeAppendReminder(hotDone, { ...makeCtx(hotDone), model: { id: "m", contextWindow: 1000 } }, tok(0.8), 0, cursor());
  assert(hotOut.length === hotDone.length + 1, "exactly one reminder per request");
  assert(firstText(hotOut[hotOut.length - 1]).includes(REMIND_MARKER), "token pressure outranks the unit boundary");

  // the counter's env var is inert now
  assert(!("toolCallBudget" in parseRemindPolicy({ DCP_REMIND_TOOLCALLS: "12" })), "DCP_REMIND_TOOLCALLS has no effect");
}

// ---------------------------------------------------------------------------
// 16. shape parsing is advisory: problems are reported, bullets are still
//     recovered (the ancestor index and the model's own text depend on it).
// ---------------------------------------------------------------------------
{
  const problemsOf = (text: string): string => parseSummary(text).problems.join(" | ");

  const canonical = parseSummary(sum("m"));
  assert(canonical.problems.length === 0, "canonical summary parses with no problems");
  assert(canonical.bySlot.get("当前任务")?.length === 1, "bullets land in their slot");

  assert(/缺少槽位/.test(problemsOf(sum("m").replace("## 未完成", "## 备注"))), "unknown slot reported (and the slot counted missing)");
  assert(/不在建议列表/.test(problemsOf(sum("m").replace("## 约束", "## 备注"))), "unknown slot named");
  assert(/证据/.test(problemsOf("## 当前任务\n- 只改了文档")), "missing evidence pointer reported");
  assert(/以「- 」开头/.test(problemsOf("## 当前任务\n只改了文档 证据: f:1")), "non-bullet line reported");
  assert(/没有槽位标题/.test(problemsOf("先说一下背景。\n做完了。")), "free-form summary reported as headerless");
  assert(!/过长/.test(problemsOf(`## 当前任务\n- ${"字".repeat(2000)} 证据: f:1`)), "a long fact is no longer a problem — length caps are gone");

  // parsing never throws, whatever comes in
  assert(parseSummary("").bullets.length === 0, "empty summary parses to nothing");
  assert(parseSummary("## 已完成\n- 无").bySlot.get("已完成")?.length === 1, '"- 无" keeps its slot filled');
}

// ---------------------------------------------------------------------------
// 17. chain recall: absorbing a block keeps its text, renders one index line,
//     and `expand` returns it in full — three levels deep.
// ---------------------------------------------------------------------------
{
  const st = createSessionState();
  const compress = createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} });
  const expand = createExpandTool({ state: st, logger, zod: zodStub });

  const L1 = sum("第一段: 摸底 src/a.ts");
  const L2 = sum("第二段: 实现 x.ts");
  const L3 = sum("第三段: 发布");
  const chain: AgentMessage[] = [
    { role: "user", content: [txt("prompt")] },
    { role: "assistant", content: [tu("m1", "bash", { command: "ls" })] },
    tres("m1", "bash", "files"),
    { role: "assistant", content: [tu("c1", "compress", { startAnchor: "session_start", summary: L1 })] },
    tres("c1", "compress", "ok"),
    { role: "assistant", content: [tu("m2", "bash", { command: "build" })] },
    tres("m2", "bash", "built"),
    { role: "assistant", content: [tu("c2", "compress", { startAnchor: "session_start", summary: L2 })] },
    tres("c2", "compress", "ok"),
    { role: "assistant", content: [tu("m3", "bash", { command: "release" })] },
    tres("m3", "bash", "released"),
    { role: "assistant", content: [tu("c3", "compress", { startAnchor: "session_start", summary: L3 })] },
    tres("c3", "compress", "ok"),
  ];

  // compress in order, each span reaching back over the previous one
  const r1 = await compress.execute("c1", { startAnchor: "session_start", summary: L1 }, undefined, undefined, makeCtx(chain.slice(0, 4)));
  assert(st.blocks.length === 1 && st.blocks[0].id === 1, "level 1 block recorded");
  assert(!textOf(r1).includes("Absorbed"), "first compression absorbs nothing");
  await compress.execute("c2", { startAnchor: "session_start", summary: L2 }, undefined, undefined, makeCtx(chain.slice(0, 8)));
  const r3 = await compress.execute("c3", { startAnchor: "session_start", summary: L3 }, undefined, undefined, makeCtx(chain.slice(0, 12)));

  assert(st.blocks.length === 3, "absorbed blocks keep their state entry (nothing is deleted)");
  const b1 = st.blocks.find((b) => b.id === 1)!;
  const b2 = st.blocks.find((b) => b.id === 2)!;
  const b3 = st.blocks.find((b) => b.id === 3)!;
  assert(b1.supersededBy === 2 && b2.supersededBy === 3 && b3.supersededBy === null, "supersede chain links 1 → 2 → 3");
  assert(b3.parentIds.join(",") === "2" && b2.parentIds.join(",") === "1", "each block names only its direct parent");
  assert(textOf(r3).includes("块 2") && textOf(r3).includes("块 1"), "compress result lists the absorbed chain with gists");
  assert(textOf(r3).includes("expand({block: 2})") && textOf(r3).includes("expand({block: 1})"), "compress result tells the model how to expand");

  // rendering: newest summary in full + one index line per ancestor, no full
  // ancestor text — the chain costs lines, not bytes
  const out = applyCompressions(st, logger, clone(chain));
  const injected = firstText(out.find((m) => firstText(m).includes("[Compressed:"))!);
  assert(injected.includes("第三段"), "newest summary rendered in full");
  assert(injected.includes("已并入本块的旧压缩块"), "ancestor index rendered");
  assert(!injected.includes("第一段: 摸底") || injected.split("第一段: 摸底").length === 2, "ancestor text does not leak into the index beyond its gist line");
  const indexLines = injected.split("\n").filter((l) => l.startsWith("- 块 "));
  assert(indexLines.length === 2, `one index line per ancestor (got ${indexLines.length})`);
  assert(indexLines.every((l) => l.length < 200), "index lines stay short");

  // expand returns the full ancestor text, and its own index for deeper recall
  const ex2 = await expand.execute("e1", { block: 2 }, undefined, undefined, makeCtx(chain));
  assert(textOf(ex2).includes("第二段: 实现 x.ts"), "expand returns the block's whole summary");
  assert(textOf(ex2).includes("expand({block: 1})"), "expand points one level further back");
  const ex1 = await expand.execute("e2", { block: 1 }, undefined, undefined, makeCtx(chain));
  assert(textOf(ex1).includes("第一段: 摸底 src/a.ts"), "expand reaches the oldest block");
  await assertThrows(() => expand.execute("e3", { block: 42 }, undefined, undefined, makeCtx(chain)), /unknown compression block 42/, "unknown block id throws with the known ids");
  await assertThrows(() => expand.execute("e4", { block: "x" as unknown as number }, undefined, undefined, makeCtx(chain)), /numeric/, "non-numeric block id throws");

  // a live block that reaches back over an earlier one absorbs it, so the
  // chain always has exactly one live tip per span
  assert(renderBlock(st.blocks, b3).ancestors.length === 2, "renderBlock exposes both ancestors for the live tip");
}

// ---------------------------------------------------------------------------
// 18. no call-count trigger: the policy carries only the token threshold, and
//     the stale-usage guard still keeps the first post-compress request quiet.
// ---------------------------------------------------------------------------
{
  const policyShape = parseRemindPolicy({});
  assert(Object.keys(policyShape).join(",") === "tokenThreshold", "remind policy is token-threshold only");
  assert(DEFAULT_TOKEN_THRESHOLD === 0.4, "default token threshold is 0.4");
  assert(parseRemindPolicy({ DCP_REMIND_THRESHOLD: "0.7" }).tokenThreshold === 0.7, "env overrides the token threshold");
  assert(parseRemindPolicy({ DCP_REMIND_THRESHOLD: "abc" }).tokenThreshold === DEFAULT_TOKEN_THRESHOLD, "garbage env falls back to the default");

  const st = createSessionState();
  const tool = createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} });
  // usage 900 describes the pre-compression context — exactly the report that
  // must stop anchoring the estimate afterwards
  const turn: AgentMessage = { role: "assistant", content: [txt("turn done")], usage: { input: 900, output: 0, totalTokens: 900 } };
  const msgs = [...convo().slice(0, 9), turn];
  await tool.execute("tu_wm", { startAnchor: "a1", summary: sum("watermark") }, undefined, undefined, makeCtx(msgs));
  assert(st.usageMark === 900, "compress records the pre-compression usage report as stale");
  assert(estimateContextTokens(msgs, 900) < 900, "stale usage falls back to the character estimate");
  const win: ExtensionContext = { ...makeCtx(msgs), model: { id: "m", contextWindow: 1000 } };
  assert(maybeAppendReminder(msgs, win, tok(0.8), 900) === msgs, "no token reminder from a stale usage report");
  assert(maybeAppendReminder(msgs, win, tok(0.8), 0).length === msgs.length + 1, "control: without the mark the same usage still fires");
}

// ---------------------------------------------------------------------------
// 19. the token reminder is bracketed: one report per 10% of the window above
//     the threshold, not one per request while the same context sits there.
// ---------------------------------------------------------------------------
{
  const at = (tokens: number): AgentMessage[] => [
    { role: "assistant", content: [txt("turn")], usage: { input: tokens, output: 0, totalTokens: tokens } },
  ];
  const ctxAt = (tokens: number): ExtensionContext => ({ ...makeCtx(at(tokens)), model: { id: "m", contextWindow: 1000 } });
  const policy = tok(0.4);
  const cursor: RemindCursor = { remindLevel: 0, unitRemindId: null };
  const fire = (tokens: number): boolean => {
    const m = at(tokens);
    return maybeAppendReminder(m, ctxAt(tokens), policy, 0, cursor).length === m.length + 1;
  };

  assert(fire(410), "first crossing of the threshold reports");
  assert(cursor.remindLevel === 4, "bracket recorded as 4 (40%)");
  assert(!fire(420), "same 10% bracket stays silent");
  assert(!fire(499), "still the same bracket at 49%");
  assert(fire(510), "the next bracket reports once");
  assert(cursor.remindLevel === 5, "bracket advanced to 5");
  assert(!fire(390), "under the threshold nothing reports");
  assert(cursor.remindLevel === 0, "bracket resets under the threshold");
  assert(fire(410), "crossing again after the reset reports again");

  assert(maybeAppendReminder(at(420), ctxAt(420), policy).length === 2, "without a cursor the reminder keeps its stateless behaviour");
  assert(tokenBracket(423255, 400000, 1000000) === 4, "bracket steps on 10% of the window");
  assert(tokenBracket(423255, 400000, undefined) === 10, "absolute mode steps on 10% of the budget");
}

// ---------------------------------------------------------------------------
// 20. the evidence terminator: `证据:` may directly follow the fact text (a
//     Chinese sentence ends with 。) and anything after the locator is part of
//     the evidence. Locators themselves are never whitelisted — a commit hash,
//     a root-level filename or a bare command are all fine (session 01a19fdd
//     lost 9 of 20 compressions to a punctuation whitelist that rejected
//     `7756e8c`, `stonecutter.properties.toml` and `git log --oneline -3`).
// ---------------------------------------------------------------------------
{
  const withEvidence = (bullet: string): string =>
    [
      "## 当前任务", `- 做事${bullet}`,
      "## 已完成", `- 做完${bullet}`,
      "## 未完成", `- 下一步${bullet}`,
      "## 约束", `- 约束${bullet}`,
      "## 文件与命令", `- 路径${bullet}`,
      "## 在跑作业与句柄", "- 无",
    ].join("\n");

  const tight = parseSummary(withEvidence("。证据: src/summary.ts:60"));
  assert(tight.bullets[0].fact === "做事。", "「。」后直接写「证据:」仍然拆得开（不需要前置空格）");
  assert(tight.bullets[0].evidence === "src/summary.ts:60", "定位原样取出");

  const annotated = parseSummary(withEvidence("证据: src/summary.ts:60（含中文说明）"));
  assert(annotated.bullets[0].evidence === "src/summary.ts:60（含中文说明）", "定位后面的中文说明保留在证据里");

  const repeated = parseSummary(withEvidence("要求行内出现 证据: 即可，真正的定位 证据: src/summary.ts:68"));
  assert(repeated.bullets[0].evidence === "src/summary.ts:68", "事实里重复出现「证据」时按最后一处切分");

  // every locator shape the old whitelist refused is accepted as-is
  for (const locator of ["7756e8c", "stonecutter.properties.toml", ".mcmcp", "git log --oneline -3", "用户原始需求", "unzip -l universal.jar"]) {
    const parsed = parseSummary(withEvidence(`证据: ${locator}`));
    assert(parsed.bullets[0].evidence === locator, `定位不设白名单：${locator}`);
    assert(parsed.problems.length === 0, `定位不设白名单且不产生提示：${locator}`);
  }
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
