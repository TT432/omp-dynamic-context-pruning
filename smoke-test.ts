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
 * there is no endAnchor.
 *
 * Run: bun smoke-test.ts
 */
import { scanAnchors, firstUserMessageIndex } from "./src/anchors";
import { applyCompressions } from "./src/transform";
import { createAddAnchorTool, createCompressTool, branchMessages } from "./src/tools";
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
import { estimateContextTokens, maybeAppendReminder, REMIND_MARKER, UNIT_MARKER, BUDGET_MARKER, parseRemindPolicy, DEFAULT_TOKEN_THRESHOLD, DEFAULT_TOOLCALL_BUDGET, toolCallsSinceLastCompress, countToolCalls, tokenBracket, finishedTodoSet } from "./src/remind";
import { Logger } from "./src/logger";
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
/** Reminder policy with only the token trigger active (unit/budget disabled). */
function tok(tokenThreshold: number) {
  return { tokenThreshold, toolCallBudget: 0 };
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

/** Canonical slot order of the summary schema (mirrors src/summary.ts). */
const SLOTS = ["当前任务", "已完成", "未完成", "约束", "文件与命令", "在跑作业与句柄"];

/** A valid slot-structured summary; `marker` lands in every slot's fact. */
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
  assert(state.dirty === false, "compress persists immediately (dirty cleared)");
  assert(appended.length === before + 1 && appended[before].customType === PERSIST_TYPE, "compress appended a dcp-state entry");
  assert(textOf(res).includes('Compressed from "a1" to this compress call'), "compress result confirms the range");
  assert(textOf(res).includes("5 message(s) elided"), "elided count spans from after the anchor to the compress call");

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
  assert(render.includes("tu_c1"), "earlier compress call kept — it sits before the new span");
  assert(render.includes("Second phase."), "work between the two compressions kept");
  assert(!render.includes("tu_a2"), "new start anchor stripped (consumed)");
  assert(!render.includes('Anchor \\"a2\\" recorded'), "new start anchor toolResult elided with the span");
  assert(render.includes("tu_c2"), "new compress call kept in context");
}

// ---------------------------------------------------------------------------
// 5. session_start as start anchor
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
  await tool2.execute("tu_c3", { startAnchor: "session_start", summary: sum("DS: early exploration done."), force: true }, undefined, undefined, makeCtx(mini.slice(0, 5)));
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
// 6. validation errors (INV-4: state unchanged on failure)
// ---------------------------------------------------------------------------
{
  const s3 = createSessionState();
  const tool3 = createCompressTool({ state: s3, logger, zod: zodStub, persist: () => {} });
  const ctx = makeCtx(convo().slice(0, 9));

  await assertThrows(
    () => tool3.execute("tu_e1", { startAnchor: "nope", summary: sum("x") }, undefined, undefined, ctx),
    /unknown startAnchor "nope".*session_start/s,
    "unknown startAnchor rejected, available anchors listed",
  );
  await assertThrows(
    () => tool3.execute("tu_e2", { startAnchor: "a1", summary: "  " }, undefined, undefined, ctx),
    /non-empty string "summary"/,
    "empty summary rejected",
  );

  // empty range: the anchor call is the last thing before the compress call
  const adjacent: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [anchorCall("tu_p1", "p1")] },
  ];
  await assertThrows(
    () => tool3.execute("tu_e3", { startAnchor: "p1", summary: sum("x") }, undefined, undefined, makeCtx(adjacent)),
    /contains no messages/,
    "empty range rejected (anchor immediately precedes the compress call)",
  );
  await assertThrows(
    () => tool3.execute("tu_e4", { startAnchor: "session_start", summary: "x" }, undefined, undefined, ctx),
    /force=true/,
    "session_start compression without force is rejected (amnesia guard)",
  );
  assert(s3.blocks.length === 0, "failed compresses record no blocks");

  // start anchor inside an active compression → reject; reaching back across
  // a prior compression from an earlier anchor → absorb
  const s4 = createSessionState();
  const pi4 = makePi([]);
  const tool4 = createCompressTool({ state: s4, logger, zod: zodStub, persist: () => saveSessionState(pi4, s4) });
  const FIRST = sum("first half");
  const EVERYTHING = sum("everything so far");
  const wide: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [anchorCall("tu_q1", "q1")] },
    tres("tu_q1", "add_anchor", "1"),
    { role: "assistant", content: [txt("mid1"), tu("tu_m1", "bash", { command: "ls" })] },
    tres("tu_m1", "bash", "files"),
    { role: "assistant", content: [anchorCall("tu_q2", "q2")] },
    tres("tu_q2", "add_anchor", "2"),
    { role: "assistant", content: [tu("tu_c1", "compress", { startAnchor: "q1", summary: "first" })] },
    tres("tu_c1", "compress", "ok"),
    { role: "assistant", content: [txt("later work"), tu("tu_m2", "bash", { command: "test" })] },
    tres("tu_m2", "bash", "pass"),
    { role: "assistant", content: [tu("tu_c2", "compress", { startAnchor: "q2", summary: "x" })] },
    tres("tu_c2", "compress", "ok"),
  ];
  await tool4.execute("tu_c1", { startAnchor: "q1", summary: FIRST }, undefined, undefined, makeCtx(wide.slice(0, 7)));
  assert(s4.blocks.length === 1, "setup block recorded");
  await assertThrows(
    () => tool4.execute("tu_c2", { startAnchor: "q2", summary: sum("x") }, undefined, undefined, makeCtx(wide.slice(0, 11))),
    /lies inside the active compression.*q1/s,
    "start anchor inside an active compression rejected (its span would be half-elided)",
  );
  assert(s4.blocks.length === 1 && s4.blocks[0].summary === FIRST, "rejection leaves existing blocks untouched");

  // absorption: compress from an earlier anchor reaching across the prior block
  const res = await tool4.execute(
    "tu_c3",
    { startAnchor: "session_start", summary: EVERYTHING, force: true },
    undefined,
    undefined,
    makeCtx(wide.slice(0, 11)),
  );
  assert(s4.blocks.length === 1 && s4.blocks[0].summary === EVERYTHING, "prior block fully contained → absorbed into the new summary");
  assert(textOf(res).includes("Absorbed 1 prior compression"), "absorption reported in the result");

  // transform of the absorbing block: the old compress pair is elided too
  const withC3: AgentMessage[] = [
    ...wide,
    { role: "assistant", content: [tu("tu_c3", "compress", { startAnchor: "session_start", summary: "everything so far" })] },
    tres("tu_c3", "compress", "ok"),
  ];
  const out = applyCompressions(s4, logger, clone(withC3));
  const render = JSON.stringify(out);
  assert(render.includes("everything so far"), "absorbing summary injected");
  assert(!render.includes("first half"), "absorbed summary never injected");
  assert(!render.includes("tu_c1"), "absorbed block's compress call elided with the span");
  assert(!render.includes("mid1") && !render.includes("later work"), "whole span elided");
  assert(render.includes("tu_c3"), "absorbing compress call kept");
}

// ---------------------------------------------------------------------------
// 7. persistence round trip (v4) + older versions ignored
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
    createdAt: 123,
  });
  s5.nextBlockId = 8;
  s5.toolCallMark = 42;
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
  assert(s6.toolCallMark === 42, "toolCallMark restored from the durable state");

  for (const v of [1, 2, 3]) {
    const oldBranch: SessionEntry[] = [
      { type: "custom", id: "c2", parentId: null, timestamp: new Date().toISOString(), customType: PERSIST_TYPE, data: { v, maps: {} } },
    ];
    const s7 = createSessionState();
    assert(loadSessionState(oldBranch, s7) === false && s7.blocks.length === 0, `v${v} entries are ignored`);
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
    summary: "seed", compressCallId: "tu_c", createdAt: 1,
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

  // orphan: block whose compress call no longer exists gets dropped + dirty
  s9.blocks.push({
    id: 99, startName: "ghost", startToolCallId: "tu_g1",
    summary: "ghost", compressCallId: "tu_gone", createdAt: 0,
  });
  s9.dirty = false;
  const out2 = applyCompressions(s9, logger, clone(msgs));
  assert(s9.blocks.length === 1 && (s9.dirty as boolean) === true, "orphan block dropped at transform time and marked dirty");
  assert(!JSON.stringify(out2).includes("ghost"), "orphan summary never injected");
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
    { startAnchor: "session_start", summary: sum("S:摸底完成。"), force: true },
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
  assert(ids.every((id) => render.includes(`"toolCallId\":\"${id}\"`) || render.includes(`"toolCallId":"${id}"`)), "no dangling toolCall without a toolResult");
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

  // end-to-end through the context handler: reminder in the outgoing copy only
  const s14 = createSessionState();
  const deps14: HandlerDeps = { state: s14, logger, pi: makePi([]), remind: tok(0.8) };
  bindSession(deps14, makeCtx(hot), "test");
  const handled = createContextHandler(deps14)({ messages: clone(hot) }, withWindow(hot, 1000));
  assert(JSON.stringify(handled.messages[handled.messages.length - 1]).includes(REMIND_MARKER), "context handler appends the reminder");
  assert(!JSON.stringify(hot).includes(REMIND_MARKER), "stored messages never gain the reminder");
}

// ---------------------------------------------------------------------------
// 15. work-unit and tool-call-budget reminders
// ---------------------------------------------------------------------------
{
  const win = (msgs: AgentMessage[], contextWindow: number): ExtensionContext => ({
    ...makeCtx(msgs),
    model: { id: "m", contextWindow },
  });
  const used = (totalTokens: number): AgentMessage => ({
    role: "assistant",
    content: [txt("turn done.")],
    usage: { input: totalTokens, output: 0, totalTokens },
  });
  const budgetPolicy = { tokenThreshold: 0, toolCallBudget: 40 };
  const ctx0 = win(convo(), 1000);

  // policy parsing: defaults + env overrides
  assert(DEFAULT_TOKEN_THRESHOLD === 0.4 && parseRemindPolicy({}).tokenThreshold === 0.4, "default token threshold is 0.4");
  assert(DEFAULT_TOOLCALL_BUDGET === 40 && parseRemindPolicy({}).toolCallBudget === 40, "default tool-call budget is 40");
  assert(parseRemindPolicy({ DCP_REMIND_THRESHOLD: "0.7" }).tokenThreshold === 0.7, "env overrides the token threshold");
  assert(parseRemindPolicy({ DCP_REMIND_TOOLCALLS: "12" }).toolCallBudget === 12, "env overrides the tool-call budget");
  assert(parseRemindPolicy({ DCP_REMIND_TOOLCALLS: "0" }).toolCallBudget === 0, "0 disables the tool-call budget");
  assert(parseRemindPolicy({ DCP_REMIND_THRESHOLD: "abc" }).tokenThreshold === DEFAULT_TOKEN_THRESHOLD, "garbage env falls back to the default");

  // unit boundary: the newest todo result reports a completed set
  const done: AgentMessage[] = [
    ...convo(),
    { role: "assistant", content: [tu("td", "todo", { op: "done" })] },
    tres("td", "todo", "All items complete"),
  ];
  assert(finishedTodoSet(done) !== null, "completed todo set detected");
  const unitOut = maybeAppendReminder(done, ctx0, budgetPolicy);
  const unitLast = unitOut[unitOut.length - 1];
  const unitText = firstText(unitLast);
  assert(unitOut.length === done.length + 1 && unitText.includes(UNIT_MARKER), "todo completion appends the unit reminder");
  assert(unitText.includes('"a1"'), "unit reminder lists the available anchors");

  // mid-progress todo set is not a boundary
  const wip: AgentMessage[] = [
    ...convo(),
    { role: "assistant", content: [tu("tw", "todo", { op: "done" })] },
    tres("tw", "todo", "Remaining items (2):"),
  ];
  assert(finishedTodoSet(wip) === null, "mid-progress todo set is not a boundary");
  assert(maybeAppendReminder(wip, ctx0, budgetPolicy) === wip, "no unit reminder while the todo set is in progress");

  // tool-call budget, reset by compress
  const calls = (n: number): AgentMessage[] => [
    { role: "user", content: [txt("go")] },
    { role: "assistant", content: Array.from({ length: n }, (_, i) => tu(`c${i}`, "bash", { command: "x" })) },
  ];
  assert(toolCallsSinceLastCompress(calls(39)) === 39, "counts tool calls since the start");
  assert(countToolCalls(convo()) === 5, "countToolCalls counts every toolCall block in the stream");
  assert(toolCallsSinceLastCompress(convo(), countToolCalls(convo())) === 0, "watermark resets the count");
  assert(toolCallsSinceLastCompress(convo(), countToolCalls(convo()) + 10) === 0, "a watermark ahead of the stream never goes negative");
  const under = calls(39);
  assert(maybeAppendReminder(under, ctx0, budgetPolicy) === under, "no budget reminder under the budget");
  const at = calls(40);
  const atOut = maybeAppendReminder(at, ctx0, budgetPolicy);
  assert(atOut.length === at.length + 1 && JSON.stringify(atOut[atOut.length - 1]).includes(BUDGET_MARKER), "budget reminder fires at the budget");
  assert(maybeAppendReminder(at, ctx0, { tokenThreshold: 0, toolCallBudget: 0 }) === at, "budget 0 disables the tool-call trigger");

  // one reminder per request; token pressure outranks the unit boundary
  const hotDone = [...done, used(900)];
  const hotOut = maybeAppendReminder(hotDone, win(hotDone, 1000), { tokenThreshold: 0.8, toolCallBudget: 1 });
  assert(hotOut.length === hotDone.length + 1, "exactly one reminder per request");
  assert(JSON.stringify(hotOut[hotOut.length - 1]).includes(REMIND_MARKER), "token pressure outranks the unit boundary");
}

// ---------------------------------------------------------------------------
// 16. summary schema — fixed slots + one evidence pointer per fact, and the
//     strict tier for session_start. Every rejection must leave state untouched
//     (INV-4); the schema runs before any branch scanning.
// ---------------------------------------------------------------------------
{
  const mk = () => {
    const st = createSessionState();
    return { st, tool: createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} }) };
  };
  const ctx = makeCtx(convo().slice(0, 9));
  /** Slot text with raw per-slot bodies (default a well-formed bullet). */
  const raw = (bodies: Partial<Record<string, string>> = {}): string =>
    SLOTS.map((slot) => `## ${slot}\n${bodies[slot] ?? "- ok 证据: f:1"}`).join("\n");
  /** Canonical summary with every fact replaced by a vague, unlocatable claim. */
  const weak = sum("m").replaceAll("证据: smoke-test.ts:1", "证据: 我记得");
  /** Canonical slots with 已完成 and 未完成 swapped. */
  const swapped = (() => {
    const blocks = SLOTS.map((slot) => `## ${slot}\n- ok 证据: f:1`);
    [blocks[1], blocks[2]] = [blocks[2], blocks[1]];
    return blocks.join("\n");
  })();

  // accepted shapes
  {
    const { st, tool } = mk();
    await tool.execute("t_ok1", { startAnchor: "a1", summary: sum("canonical") }, undefined, undefined, ctx);
    assert(st.blocks.length === 1, "canonical slot summary accepted");
  }
  {
    const { st, tool } = mk();
    await tool.execute("t_ok2", { startAnchor: "a1", summary: sum("m", { 约束: "无", 在跑作业与句柄: "无" }) }, undefined, undefined, ctx);
    assert(st.blocks.length === 1, '"- 无" fills a slot that has nothing to report');
  }
  {
    // vague evidence is only fatal at the strict tier — tier 1 still accepts it,
    // so small compressions stay cheap
    const { st, tool } = mk();
    await tool.execute("t_ok3", { startAnchor: "a1", summary: weak }, undefined, undefined, ctx);
    assert(st.blocks.length === 1, "tier 1 tolerates a vague evidence pointer");
  }

  // rejected shapes
  const cases: [string, string, RegExp][] = [
    ["missing slot", sum("m").replace("## 未完成\n- m — 未完成 证据: smoke-test.ts:1\n", ""), /缺少槽位：未完成/],
    ["wrong slot order", swapped, /顺序错误/],
    ["unknown slot", sum("m").replace("## 约束", "## 备注"), /未知槽位「备注」/],
    ["bullet without evidence", raw({ 约束: "- 只改了文档" }), /证据: <定位>/],
    ["non-bullet line", raw({ 约束: "只改了文档 证据: f:1" }), /以「- 」开头/],
    ["empty 当前任务", raw({ 当前任务: "- 无" }), /必须是实际任务/],
    ["free-form preamble", `先说一下背景。\n${sum("m")}`, /第一条内容之前/],
    ["pasted fact", raw({ 约束: `- ${"字".repeat(601)} 证据: f:1` }), /事实过长/],
    ["evidence placeholder", raw({ 约束: "- 事实 证据: 无" }), /没有意义/],
  ];
  for (const [label, text, pattern] of cases) {
    const { st, tool } = mk();
    await assertThrows(
      () => tool.execute("t_bad", { startAnchor: "a1", summary: text }, undefined, undefined, ctx),
      pattern,
      `summary rejected: ${label}`,
    );
    assert(st.blocks.length === 0 && st.dirty === false, `INV-4: ${label} leaves state untouched`);
  }

  // strict tier (session_start + force): real work record + locatable evidence
  const strict: [string, string, RegExp][] = [
    ["已完成 empty", sum("m", { 已完成: "无" }), /「已完成」写明实际内容/],
    ["未完成 empty", sum("m", { 未完成: "无" }), /「未完成」写明实际内容/],
    ["vague evidence", weak, /不含任何定位/],
  ];
  for (const [label, text, pattern] of strict) {
    const { st, tool } = mk();
    await assertThrows(
      () => tool.execute("t_strict", { startAnchor: "session_start", summary: text, force: true }, undefined, undefined, ctx),
      pattern,
      `full-session summary rejected: ${label}`,
    );
    assert(st.blocks.length === 0, `INV-4: strict ${label} leaves state untouched`);
  }
}

// ---------------------------------------------------------------------------
// 17. baseline inheritance — a compress that absorbs a prior block must carry
//     that block's locatable facts, or say they are superseded. This is the
//     failure that made session 01a18dc1 re-propose already-committed work.
// ---------------------------------------------------------------------------
{
  const slotSummary = (bodies: Record<string, string>): string =>
    SLOTS.map((slot) => `## ${slot}\n- ${bodies[slot] ?? "无"}`).join("\n");

  const OLD = slotSummary({
    当前任务: "旧工作单元 证据: src/legacy.ts:1",
    已完成: "新增 src/legacy.ts 导出 证据: src/legacy.ts:12",
    约束: "不得改动 `INV-4` 语义 证据: docs/design.md:64",
  });

  /** Prior block (a1 → tu_c1) is fully contained in the new span (tu_c2). */
  const harness = (oldSummary = OLD) => {
    const st = createSessionState();
    st.blocks.push({
      id: 2,
      startName: "a1",
      startToolCallId: "tu_a1",
      summary: oldSummary,
      compressCallId: "tu_c1",
      createdAt: 1,
    });
    st.nextBlockId = 3;
    const tool = createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} });
    const msgs: AgentMessage[] = [
      { role: "user", content: [txt("p")] },
      { role: "assistant", content: [anchorCall("tu_a1", "a1")] },
      tres("tu_a1", "add_anchor", "1"),
      { role: "assistant", content: [txt("work"), tu("tu_m1", "bash", { command: "ls" })] },
      tres("tu_m1", "bash", "files"),
      { role: "assistant", content: [tu("tu_c1", "compress", { startAnchor: "a1", summary: oldSummary })] },
      tres("tu_c1", "compress", "ok"),
      { role: "assistant", content: [txt("more")] },
      { role: "assistant", content: [tu("tu_c2", "compress", { startAnchor: "session_start", summary: "new" })] },
      tres("tu_c2", "compress", "ok"),
    ];
    return { st, tool, ctx: makeCtx(msgs) };
  };

  /** Strict-tier summary that carries every locator of OLD unless overridden. */
  const carried = (overrides: Record<string, string> = {}): string =>
    slotSummary({
      当前任务: "接着旧工作单元 证据: src/legacy.ts:1",
      已完成: "旧导出保留 证据: src/legacy.ts:12",
      未完成: "跑测试 证据: smoke-test.ts:1",
      约束: "不得改动 `INV-4` 语义 证据: docs/design.md:64",
      ...overrides,
    });

  // inheritance satisfied → absorbed
  {
    const { st, tool, ctx } = harness();
    const next = carried();
    const res = await tool.execute("tu_c2", { startAnchor: "session_start", summary: next, force: true }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary === next, "absorbing summary that carries the old locators is accepted");
    assert(textOf(res).includes("Absorbed 1 prior compression"), "absorption of an inherited block is reported");
  }

  // a dropped constraint key is refused, and nothing mutates
  {
    const { st, tool, ctx } = harness();
    await assertThrows(
      () => tool.execute("tu_c2", { startAnchor: "session_start", summary: carried({ 约束: "无" }), force: true }, undefined, undefined, ctx),
      /基线继承[\s\S]*inv-4/,
      "absorbing summary that drops a constraint locator is refused",
    );
    assert(st.blocks.length === 1 && st.blocks[0].summary === OLD && st.nextBlockId === 3, "INV-4: inheritance rejection leaves state untouched");
  }

  // a dropped completed-work locator is refused even when the rest is detailed
  {
    const { st, tool, ctx } = harness();
    await assertThrows(
      () =>
        tool.execute(
          "tu_c2",
          {
            startAnchor: "session_start",
            summary: carried({ 当前任务: "继续 证据: smoke-test.ts:1", 已完成: "全部测试通过 证据: smoke-test.ts:9" }),
            force: true,
          },
          undefined,
          undefined,
          ctx,
        ),
      /src\/legacy\.ts/,
      "absorbing summary that drops a completed-work locator is refused",
    );
    assert(st.blocks.length === 1 && st.blocks[0].summary === OLD, "refused absorption records no new block");
  }

  // explicit supersede keeps the locator and passes
  {
    const { st, tool, ctx } = harness();
    const next = slotSummary({
      当前任务: "改用新模块 证据: src/legacy.ts:1",
      已完成: "旧导出已废弃：改由 src/new.ts 提供 证据: src/legacy.ts:12",
      未完成: "补测试 证据: smoke-test.ts:1",
      约束: "不得改动 `INV-4` 语义 证据: docs/design.md:64",
    });
    await tool.execute("tu_c2", { startAnchor: "session_start", summary: next, force: true }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary === next, "explicitly superseded fact (with its locator) is accepted");
  }

  // locator matching ignores slot moves, case and separators
  {
    const { st, tool, ctx } = harness(slotSummary({ 当前任务: "旧 证据: a.ts:1", 已完成: "改 src\\legacy.ts 的导出 证据: a.ts:2" }));
    const next = carried({ 约束: "无", 已完成: "见 SRC/Legacy.ts 证据: smoke-test.ts:1" });
    await tool.execute("tu_c2", { startAnchor: "session_start", summary: next, force: true }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary === next, "locator survives slot move, case change and separator change");
  }

  // facts without a locator are not checked, and pre-schema blocks never block
  {
    const plain = slotSummary({ 当前任务: "旧 证据: a.ts:1", 已完成: "修好了渲染 证据: a.ts:2" });
    const { st, tool, ctx } = harness(plain);
    await tool.execute("tu_c2", { startAnchor: "session_start", summary: carried({ 约束: "无" }), force: true }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary !== plain, "fact without a locator is not required to survive");
  }
  {
    const freeForm = "历史自由文本：改过 src/legacy.ts，细节见旧日志";
    const { st, tool, ctx } = harness(freeForm);
    await tool.execute("tu_c2", { startAnchor: "session_start", summary: carried({ 约束: "无" }), force: true }, undefined, undefined, ctx);
    assert(st.blocks.length === 1 && st.blocks[0].summary !== freeForm, "pre-schema block is skipped instead of blocking the compress");
  }
}

// ---------------------------------------------------------------------------
// 18. budget cost resets from the durable watermark, including a compress that
//     leaves no compress call in the message stream (eval kernel:
//     await tool.write({path:"xd://compress"})). Live session 01a18dc1 claimed
//     "60 tool calls since the last compress" right after a successful one.
// ---------------------------------------------------------------------------
{
  const st = createSessionState();
  const tool = createCompressTool({ state: st, logger, zod: zodStub, persist: () => {} });
  // usage 900 describes the pre-compression context — exactly the report that
  // must stop anchoring the estimate afterwards
  const turn: AgentMessage = { role: "assistant", content: [txt("turn done")], usage: { input: 900, output: 0, totalTokens: 900 } };
  const msgs = [...convo().slice(0, 9), turn]; // no compress call anywhere in the stream
  await tool.execute("tu_wm", { startAnchor: "a1", summary: sum("watermark") }, undefined, undefined, makeCtx(msgs));
  assert(st.toolCallMark === countToolCalls(msgs), "compress records the watermark from the live tool-call count");
  assert(st.usageMark === 900, "compress records the pre-compression usage report as stale");
  assert(estimateContextTokens(msgs, 900) < 900, "stale usage falls back to the character estimate");
  const win = { ...makeCtx(msgs), model: { id: "m", contextWindow: 1000 } };
  assert(maybeAppendReminder(msgs, win, tok(0.8), 0, 900) === msgs, "no token reminder from a stale usage report");
  assert(maybeAppendReminder(msgs, win, tok(0.8), 0, 0).length === msgs.length + 1, "control: without the mark the same usage still fires");

  const policy = { tokenThreshold: 0, toolCallBudget: 40 };
  assert(maybeAppendReminder(msgs, makeCtx(msgs), policy, st.toolCallMark) === msgs, "no budget reminder right after a compression");

  const many = [...msgs, { role: "assistant", content: Array.from({ length: 40 }, (_, i) => tu(`wm${i}`, "bash", { command: "x" })) }];
  const fired = maybeAppendReminder(many, makeCtx(many), policy, st.toolCallMark);
  const firedText = firstText(fired[fired.length - 1]);
  assert(fired.length === many.length + 1 && firedText.includes(BUDGET_MARKER), "budget fires only after 40 calls past the watermark");
  assert(firedText.includes("force=true"), "a full-session wipe is called out instead of offered as a peer anchor");
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
  const policy = { tokenThreshold: 0.4, toolCallBudget: 0 };
  const cursor = { remindLevel: 0 };
  const fire = (tokens: number): boolean => {
    const m = at(tokens);
    return maybeAppendReminder(m, ctxAt(tokens), policy, 0, 0, cursor).length === m.length + 1;
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

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
