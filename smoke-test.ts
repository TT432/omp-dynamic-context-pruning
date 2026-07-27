/**
 * Smoke test — exercises the anchor-based compression pipeline against
 * synthetic omp messages in the real pi-mono shape (verified against live
 * session transcripts): assistant messages carry `{type:"toolCall", id, name,
 * arguments}` blocks; tool results are standalone `{role:"toolResult",
 * toolCallId}` messages. Extension tools invoked via the xd:// envelope
 * (`write({path:"xd://add_anchor", content:"<json>"})`) are covered too.
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

// Minimal zod stand-in: the tool factories only build the parameter schema at
// registration time; execute() re-validates fields itself.
const zodStub = {
  object: (shape: unknown) => ({ shape }),
  string: () => ({}),
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

function compressOn(tool: ToolDefinition, params: { startAnchor: string; endAnchor: string; summary: string }, ctx: ExtensionContext) {
  return tool.execute(`tu_call_${params.endAnchor}`, params, undefined, undefined, ctx);
}

/**
 * Base conversation (indices matter — assertions reference them):
 *  0 user       "Build a demo app."                     ← original prompt
 *  1 assistant  text + bash tu_w1
 *  2 toolResult tu_w1
 *  3 assistant  "Marking a1." + add_anchor(a1) tu_a1    ← start anchor (with text)
 *  4 toolResult tu_a1
 *  5 assistant  "Working on feature X." + write tu_w2
 *  6 toolResult tu_w2
 *  7 assistant  "Feature X done." + add_anchor(a2) tu_a2 ← end anchor (with text)
 *  8 toolResult tu_a2
 *  9 assistant  compress tu_c1
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
    { role: "assistant", content: [txt("Feature X done."), anchorCall("tu_a2", "a2")] },
    tres("tu_a2", "add_anchor", 'Anchor "a2" recorded.'),
    { role: "assistant", content: [tu("tu_c1", "compress", { startAnchor: "a1", endAnchor: "a2", summary: "D1" })] },
    tres("tu_c1", "compress", "Compressed a1 → a2"),
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
  assert(anchors.map((a) => a.name).join(",") === "session_start,a1,a2", "scanAnchors finds session_start + named anchors in order");
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
    { role: "assistant", content: [tu("w3", "write", { path: "xd://compress", content: '{"startAnchor":"x1","endAnchor":"x2","summary":"s"}' })] },
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
// 3. compress happy path + transform
// ---------------------------------------------------------------------------
{
  const before = appended.length;
  const res = await compressTool.execute(
    "tu_c1",
    { startAnchor: "a1", endAnchor: "a2", summary: "D1: built feature X in x.ts." },
    undefined,
    undefined,
    makeCtx(convo().slice(0, 9)),
  );
  assert(state.blocks.length === 1, "compress records one block");
  const b = state.blocks[0];
  assert(
    b.startName === "a1" && b.startToolCallId === "tu_a1" && b.endName === "a2" && b.endToolCallId === "tu_a2" && b.compressCallId === "tu_c1",
    "block stores anchor names, tool-call ids, and the compress call id",
  );
  assert(state.dirty === false, "compress persists immediately (dirty cleared)");
  assert(appended.length === before + 1 && appended[before].customType === PERSIST_TYPE, "compress appended a dcp-state entry");
  assert(textOf(res).includes('Compressed "a1" → "a2"'), "compress result confirms the range");

  // out = [prompt, MARKER, msg1, msg2, msg3'(text only), SUMMARY, msg7, msg8]
  const out = applyCompressions(state, logger, clone(convo()));
  const render = JSON.stringify(out);
  assert(out.length === 8, `transform elides 3 + drops 2 stripped messages, injects marker + summary (got ${out.length})`);
  assert(JSON.stringify(out[1]).includes("session_start"), "session_start marker sits right after the prompt");
  assert(render.includes("Marking a1."), "start anchor message keeps its non-anchor text");
  assert(!render.includes("tu_a1"), "start anchor toolCall stripped (anchor consumed)");
  assert(!render.includes("Working on feature X."), "span content elided");
  assert(!render.includes('Anchor \\"a1\\" recorded'), "start anchor toolResult elided");
  assert(render.includes("Feature X done."), "end anchor message survives with its text");
  assert(render.includes("tu_a2"), "end anchor toolCall survives (kept for chaining)");
  assert(render.includes("[Compressed: a1 → a2]") && render.includes("D1: built feature X"), "summary injected with header");
  assert(!render.includes("tu_c1"), "compress call itself stripped from context");
  assert(JSON.stringify(out[5]).includes("[Compressed: a1 → a2]"), "summary takes the place of the elided span, before the end anchor");
  assert(JSON.stringify(out[6]).includes("tu_a2") && JSON.stringify(out[7]).includes("tu_a2"), "end anchor call and result follow the summary");
  assert(convo().length === 11 && !JSON.stringify(convo()).includes("[Compressed"), "transform never mutates the source conversation");
}

// ---------------------------------------------------------------------------
// 4. chaining: compress(a2 → a3) keeps both blocks; summaries accumulate
// ---------------------------------------------------------------------------
{
  const extended: AgentMessage[] = [
    ...convo(),
    { role: "assistant", content: [txt("Second phase."), tu("tu_w3", "bash", { command: "test" })] },
    tres("tu_w3", "bash", "pass"),
    { role: "assistant", content: [anchorCall("tu_a3", "a3")] },
    tres("tu_a3", "add_anchor", 'Anchor "a3" recorded.'),
    { role: "assistant", content: [tu("tu_c2", "compress", { startAnchor: "a2", endAnchor: "a3", summary: "D2" })] },
    tres("tu_c2", "compress", "ok"),
  ];
  const res = await compressTool.execute(
    "tu_c2",
    { startAnchor: "a2", endAnchor: "a3", summary: "D2: phase two, tests pass." },
    undefined,
    undefined,
    makeCtx(extended.slice(0, 14)),
  );
  assert(state.blocks.length === 2 && state.blocks[0].id === 1 && state.blocks[1].id === 2, "chained compress keeps both blocks — summaries accumulate");
  assert(!textOf(res).includes("Absorbed"), "chaining absorbs nothing");

  // out = [prompt, MARKER, msg1, msg2, msg3', SUMMARY1, msg7'(text only), SUMMARY2, msg13, msg14]
  const out = applyCompressions(state, logger, clone(extended));
  const render = JSON.stringify(out);
  assert(render.includes("D1: built feature X"), "earlier chained summary stays in place");
  assert(render.includes("D2: phase two"), "new summary injected");
  assert(render.indexOf("D1: built feature X") < render.indexOf("D2: phase two"), "summaries accumulate in order");
  assert(!render.includes("tu_a2"), "shared anchor stripped once used as a start");
  assert(render.includes("Feature X done."), "shared anchor message keeps its text");
  assert(render.includes("Marking a1."), "earlier consumed start text survives");
  assert(render.includes("tu_a3"), "new end anchor survives");
  assert(!render.includes("Second phase."), "chained span content elided");
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
    { role: "assistant", content: [tu("tu_c3", "compress", { startAnchor: "session_start", endAnchor: "b1", summary: "DS" })] },
    tres("tu_c3", "compress", "ok"),
  ];
  await tool2.execute("tu_c3", { startAnchor: "session_start", endAnchor: "b1", summary: "DS: early exploration done." }, undefined, undefined, makeCtx(mini.slice(0, 5)));
  assert(s2.blocks.length === 1 && s2.blocks[0].startToolCallId === null, "session_start block stores a null startToolCallId");

  // out = [prompt, MARKER, SUMMARY, anchor(b1), tr_b1]
  const out = applyCompressions(s2, logger, clone(mini));
  const render = JSON.stringify(out);
  assert(out.length === 5, `session_start compression keeps prompt + marker + summary + end anchor pair (got ${out.length})`);
  assert(render.includes("Original prompt."), "original prompt preserved");
  assert(render.includes("[anchor: session_start"), "session_start marker preserved (never consumed)");
  assert(!render.includes("tu_x1"), "post-prompt span elided");
  assert(JSON.stringify(out[2]).includes("[Compressed: session_start → b1]"), "summary before the end anchor, header cites session_start");
  assert(JSON.stringify(out[3]).includes("tu_b1"), "end anchor follows the summary");
  assert(!render.includes("tu_c3"), "compress call stripped");
}

// ---------------------------------------------------------------------------
// 6. validation errors (INV-4: state unchanged on failure)
// ---------------------------------------------------------------------------
{
  const s3 = createSessionState();
  const tool3 = createCompressTool({ state: s3, logger, zod: zodStub, persist: () => {} });
  const ctx = makeCtx(convo().slice(0, 9));

  await assertThrows(() => compressOn(tool3, { startAnchor: "nope", endAnchor: "a2", summary: "x" }, ctx), /unknown startAnchor "nope".*session_start/s, "unknown startAnchor rejected, available anchors listed");
  await assertThrows(() => compressOn(tool3, { startAnchor: "a1", endAnchor: "nope", summary: "x" }, ctx), /unknown endAnchor/, "unknown endAnchor rejected");
  await assertThrows(() => compressOn(tool3, { startAnchor: "a1", endAnchor: "a1", summary: "x" }, ctx), /must differ/, "same anchor rejected");
  await assertThrows(() => compressOn(tool3, { startAnchor: "a2", endAnchor: "a1", summary: "x" }, ctx), /must come before/, "reversed range rejected");
  await assertThrows(() => compressOn(tool3, { startAnchor: "a1", endAnchor: "session_start", summary: "x" }, ctx), /cannot be endAnchor/, "session_start as end rejected");
  await assertThrows(() => compressOn(tool3, { startAnchor: "a1", endAnchor: "a2", summary: "  " }, ctx), /non-empty string "summary"/, "empty summary rejected");

  // empty range: two anchor calls in directly adjacent assistant messages
  const adjacent: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [anchorCall("tu_p1", "p1")] },
    { role: "assistant", content: [anchorCall("tu_p2", "p2")] },
  ];
  await assertThrows(
    () => compressOn(tool3, { startAnchor: "p1", endAnchor: "p2", summary: "x" }, makeCtx(adjacent)),
    /contains no messages/,
    "empty range rejected",
  );
  assert(s3.blocks.length === 0, "failed compresses record no blocks");

  // same-end rejection + end-inside rejection + full subsumption + true partial
  const s4 = createSessionState();
  const pi4 = makePi([]);
  const tool4 = createCompressTool({ state: s4, logger, zod: zodStub, persist: () => saveSessionState(pi4, s4) });
  const wide: AgentMessage[] = [
    { role: "user", content: [txt("p")] },
    { role: "assistant", content: [anchorCall("tu_q1", "q1")] },
    tres("tu_q1", "add_anchor", "1"),
    { role: "assistant", content: [txt("mid1"), anchorCall("tu_q2", "q2")] },
    tres("tu_q2", "add_anchor", "2"),
    { role: "assistant", content: [txt("mid2"), anchorCall("tu_q3", "q3")] },
    tres("tu_q3", "add_anchor", "3"),
    { role: "assistant", content: [anchorCall("tu_q4", "q4")] },
    tres("tu_q4", "add_anchor", "4"),
  ];
  await compressOn(tool4, { startAnchor: "q2", endAnchor: "q3", summary: "middle" }, makeCtx(wide));
  assert(s4.blocks.length === 1, "setup block recorded");
  await assertThrows(
    () => compressOn(tool4, { startAnchor: "q1", endAnchor: "q3", summary: "x" }, makeCtx(wide)),
    /already ends an active compression.*chain/s,
    "reusing an active end anchor rejected with chaining hint",
  );
  await assertThrows(
    () => compressOn(tool4, { startAnchor: "q1", endAnchor: "q2", summary: "x" }, makeCtx(wide)),
    /inside the active compression/,
    "end anchor inside an active compression rejected (its survival is unguaranteed)",
  );
  assert(s4.blocks.length === 1, "rejections leave existing blocks untouched");
  // full subsumption: q1 → q4 fully contains (q2 → q3)
  await compressOn(tool4, { startAnchor: "q1", endAnchor: "q4", summary: "everything" }, makeCtx(wide));
  assert(s4.blocks.length === 1 && s4.blocks[0].summary === "everything", "fully-contained block absorbed by the wider range");

  // true partial overlap: block (q1 → q3) vs new (q2 → q4) — interleaved spans
  const s4b = createSessionState();
  const tool4b = createCompressTool({ state: s4b, logger, zod: zodStub, persist: () => {} });
  await compressOn(tool4b, { startAnchor: "q1", endAnchor: "q3", summary: "first half" }, makeCtx(wide));
  await assertThrows(
    () => compressOn(tool4b, { startAnchor: "q2", endAnchor: "q4", summary: "x" }, makeCtx(wide)),
    /partially overlaps/,
    "interleaved range rejected as partial overlap",
  );
  assert(s4b.blocks.length === 1, "partial-overlap rejection leaves blocks untouched");
}

// ---------------------------------------------------------------------------
// 7. persistence round trip (v3) + older versions ignored
// ---------------------------------------------------------------------------
{
  const s5 = createSessionState();
  s5.sessionId = "sess-persist";
  s5.blocks.push({
    id: 7,
    startName: "a1",
    startToolCallId: "tu_a1",
    endName: "a2",
    endToolCallId: "tu_a2",
    summary: "S",
    compressCallId: "tu_c",
    createdAt: 123,
  });
  s5.nextBlockId = 8;
  s5.dirty = true;
  const app: { customType: string; data: unknown }[] = [];
  saveSessionState(makePi(app), s5);
  assert(app.length === 1 && s5.dirty === false, "save appends one entry and clears dirty");

  const branch: SessionEntry[] = [
    { type: "custom", id: "c1", parentId: null, timestamp: new Date().toISOString(), customType: PERSIST_TYPE, data: app[0].data },
  ];
  const s6 = createSessionState();
  const loaded = loadSessionState(branch, s6);
  assert(loaded && s6.blocks.length === 1 && s6.blocks[0].id === 7 && s6.blocks[0].compressCallId === "tu_c", "round trip restores the block");
  assert(s6.nextBlockId === 8, "nextBlockId restored");

  for (const v of [1, 2]) {
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
  const deps: HandlerDeps = { state: s8, logger, pi: pi8 };

  const seeded = createSessionState();
  seeded.sessionId = "sess-life";
  seeded.blocks.push({
    id: 3, startName: "a", startToolCallId: "tu_a", endName: "b", endToolCallId: "tu_b",
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
  const deps9: HandlerDeps = { state: s9, logger, pi: makePi([]) };
  // bind first — compress always happens on an already-bound session
  bindSession(deps9, makeCtx(msgs), "test");
  await compressOn(tool9, { startAnchor: "a1", endAnchor: "a2", summary: "D1 again." }, makeCtx(msgs.slice(0, 9)));

  const handler = createContextHandler(deps9);
  const result = handler({ messages: clone(msgs) }, makeCtx(msgs));
  const render = JSON.stringify(result.messages);
  assert(render.includes("[anchor: session_start") && render.includes("D1 again.") && !render.includes("Working on feature X."), "context handler returns the transformed conversation");
  assert(s9.sessionId !== null, "context handler lazy-binds the session");

  // orphan: block whose end anchor no longer exists gets dropped + dirty
  s9.blocks.push({
    id: 99, startName: "ghost1", startToolCallId: "tu_g1", endName: "ghost2", endToolCallId: "tu_gone",
    summary: "ghost", compressCallId: "tu_gc", createdAt: 0,
  });
  s9.dirty = false;
  const out2 = applyCompressions(s9, logger, clone(msgs));
  assert(s9.blocks.length === 1 && s9.dirty === true, "orphan block dropped at transform time and marked dirty");
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
    { role: "assistant", content: [tu("tu_c9", "write", { path: "xd://compress", content: '{"startAnchor":"session_start","endAnchor":"reorg_done","summary":"S"}' })] },
    tres("tu_c9", "write", "Compressed"),
  ];
  // the exact reported flow: compress right after the anchor was added
  const res = await tool10.execute(
    "tu_c9",
    { startAnchor: "session_start", endAnchor: "reorg_done", summary: "S:摸底完成。" },
    undefined,
    undefined,
    makeCtx(live.slice(0, 5)),
  );
  assert(s10.blocks.length === 1 && s10.blocks[0].endToolCallId === "w1", "xd-enveloped end anchor resolves immediately after add_anchor");
  assert(textOf(res).includes('Compressed "session_start" → "reorg_done"'), "compress confirms the enveloped range");

  const out = applyCompressions(s10, logger, clone(live));
  const render = JSON.stringify(out);
  assert(render.includes("S:摸底完成。"), "summary injected for enveloped block");
  assert(!render.includes("file a"), "span elided through the envelope");
  assert(render.includes("w1"), "enveloped end anchor survives");
  assert(!render.includes("tu_c9"), "enveloped compress call stripped");
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
    // start anchor shares its message with a real bash call
    { role: "assistant", content: [anchorCall("t_a", "a"), tu("t_b", "bash", { command: "ls" })] },
    tres("t_a", "add_anchor", "ok"),
    tres("t_b", "bash", "files"),
    { role: "assistant", content: [anchorCall("t_c", "c")] },
    tres("t_c", "add_anchor", "ok"),
    // compress call accompanies a thinking block — stripping must drop the shell
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, tu("t_x", "compress", { startAnchor: "a", endAnchor: "c", summary: "S" })] },
    tres("t_x", "compress", "ok"),
  ];
  await tool11.execute("t_x", { startAnchor: "a", endAnchor: "c", summary: "S: done." }, undefined, undefined, makeCtx(conv.slice(0, 6)));

  // out = [prompt, MARKER, SUMMARY, anchor(t_c), tres(t_c)]
  const out = applyCompressions(s11, logger, clone(conv));
  const render = JSON.stringify(out);
  assert(out.length === 5, `shell drop + orphan guard yields prompt+marker+summary+end pair (got ${out.length})`);
  assert(!render.includes("t_b"), "orphan guard strips the call whose toolResult was elided");
  assert(!render.includes("t_a"), "start anchor stripped");
  assert(!render.includes("hmm"), "thinking-only assistant shell dropped after stripping");
  assert(render.includes("S: done."), "summary injected");
  assert(render.includes("t_c"), "end anchor call kept");
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

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
