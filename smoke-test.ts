/**
 * Smoke test — exercises the core DCP pipeline against synthetic omp messages.
 * Run: bun smoke-test.ts
 */
import { createSessionState } from "./src/state/state";
import { buildToolMetadata, countUserTurns } from "./src/messages/query";
import { assignMessageRefs } from "./src/messages/identity";
import { prune } from "./src/messages/prune";
import { deduplicate } from "./src/strategies/deduplication";
import { purgeErrors } from "./src/strategies/purge-errors";
import { applyCompressionState, wrapCompressedSummary, allocateRunId, allocateBlockId } from "./src/state/utils";
import { buildRangeContext, resolveRanges, validateNonOverlapping, foldConsumedBlocks } from "./src/compress/range-utils";
import { DEFAULT_CONFIG } from "./src/config";
import { Logger } from "./src/logger";
import { estimateMessagesTokens } from "./src/token-utils";

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

// Synthetic omp conversation
function txt(t: string) { return { type: "text", text: t }; }
function tu(id: string, name: string, input: unknown) { return { type: "tool_use", id, name, input }; }
function tr(id: string, text: string, isError = false) {
  return { type: "tool_result", tool_use_id: id, content: [txt(text)], is_error: isError } as const;
}

const state = createSessionState();
const messages = [
  { role: "user", content: [txt("Please read the config file.")] },
  { role: "assistant", content: [tu("toolu_1", "read", { path: "config.json" })] },
  { role: "user", content: [tr("toolu_1", "{ \"debug\": true }")] },
  { role: "assistant", content: [txt("Got it."), tu("toolu_2", "read", { path: "config.json" })] },
  { role: "user", content: [tr("toolu_2", "{ \"debug\": true }")] }, // duplicate of toolu_1
  { role: "assistant", content: [tu("toolu_3", "bash", { command: "rm -rf /" })] },
  { role: "user", content: [tr("toolu_3", "permission denied", true)] }, // errored
  { role: "assistant", content: [txt("Done.")] },
];

// 1. tool metadata + turns
buildToolMetadata(state, messages);
assert(state.toolIdList.length === 3, "toolIdList has 3 tool_use ids");
assert(state.toolParameters.get("toolu_3")?.status === "error", "toolu_3 marked error");
assert(countUserTurns(messages) === 4, "4 user turns");

// 2. dedup marks the older identical read (toolu_1)
deduplicate(state, DEFAULT_CONFIG, logger);
assert(state.prune.tools.has("toolu_1"), "dedup marked older duplicate toolu_1");
assert(!state.prune.tools.has("toolu_2"), "dedup kept most recent toolu_2");

// purge-errors: toolu_3 errored, age 0 turns (currentTurn 0) -> not yet. Bump turn.
state.currentTurn = 10;
state.prune.tools = new Map();
deduplicate(state, DEFAULT_CONFIG, logger);
purgeErrors(state, DEFAULT_CONFIG, logger);
assert(state.prune.tools.has("toolu_1"), "dedup still marks toolu_1");
assert(state.prune.tools.has("toolu_3"), "purgeErrors marks errored toolu_3 (old enough)");

// 3. prune replaces tool_result content for pruned ids
state.prune.tools = new Map();
state.prune.tools.set("toolu_1", 10);
state.prune.tools.set("toolu_3", 10);
const clone = messages.map((m) => ({ ...m, content: [...m.content] }));
assignMessageRefs(state, clone);
const pruned = prune(state, logger, DEFAULT_CONFIG, clone);
const tr1 = pruned[2].content[0] as { content: { text: string }[] };
assert(/Output removed/.test(tr1.content[0].text), "pruned toolu_1 result replaced with placeholder");

// 4. NO inline tags — the leak fix. Messages must carry no <dcp-message-id>.
assert(!/<dcp-message-id>/.test(JSON.stringify(pruned)), "no <dcp-message-id> tags leak into context");

// 5-6. compression via CONTENT ANCHORS (verbatim phrase substring match).
state.prune.tools = new Map();
state.prune.messages.byMessageId = new Map();
state.prune.messages.blocksById = new Map();
state.prune.messages.activeBlockIds = new Set();
state.prune.messages.activeByAnchorMessageId = new Map();

const work = messages.map((m) => ({ ...m, content: m.content.map((b) => structuredClone(b)) }));
assignMessageRefs(state, work); // no-op for citation now; kept for state consistency
assert(!/<dcp-message-id>/.test(JSON.stringify(work)), "no tags injected into context");

const ctx = buildRangeContext(work, state);
// anchors: "Please read the config file" (user request, idx0 — a UNIQUE phrase;
// note "config.json" alone is now ambiguous: it matches BOTH reads at idx1 and
// idx3, which the tool rejects) .. "denied" (errored result, idx6).
const args = {
  topic: "Initial exploration",
  content: [{ startAnchor: "Please read the config file", endAnchor: "denied", summary: "Explored config.json; it has debug:true. A duplicate read and a failed rm were attempted." }],
};
const plans = resolveRanges(args, ctx);
validateNonOverlapping(plans);
assert(plans[0].selection.startIndex === 0, "startAnchor located the user request (unique anchor)");
assert(plans[0].selection.endIndex === 6, "endAnchor located the errored result");
assert(plans[0].selection.messageIds.length >= 5, "range selection spans the expected messages");

// 5b. Ambiguous anchor rejection: "config.json" matches idx1 AND idx3, so it
// must throw rather than silently compressing the wrong span.
try {
  resolveRanges({ topic: "ambiguous", content: [{ startAnchor: "config.json", endAnchor: "denied", summary: "x" }] }, ctx);
  assert(false, "ambiguous startAnchor should throw");
} catch (e) {
  assert(/ambiguous/i.test(String(e)), "ambiguous startAnchor rejected with error");
}

const runId = allocateRunId(state);
const blockId = allocateBlockId(state);
const stored = wrapCompressedSummary(args.topic, plans[0].entry.summary);
applyCompressionState(state, { topic: args.topic, batchTopic: args.topic, startId: plans[0].entry.startAnchor, endId: plans[0].entry.endAnchor, mode: "range", runId, summaryTokens: 30 }, plans[0].selection, plans[0].anchorMessageId, blockId, stored, plans[0].selection.requiredBlockIds);
assert(state.prune.messages.activeBlockIds.size === 1, "one active compression block");

// prune injects the summary (readable header) at the earliest effective message
// and elides the compressed span — on a fresh rebuild from originals.
const rebuild = messages.map((m) => ({ ...m, content: m.content.map((b) => structuredClone(b)) }));
const pruned2 = prune(state, logger, DEFAULT_CONFIG, rebuild);
const rendered = JSON.stringify(pruned2);
assert(/\[Compressed conversation section: Initial exploration\]/.test(rendered), "summary injected with readable header");
assert(!/"debug.:.true/.test(rendered), "compressed span content elided");
assert(!/<dcp-message-id>/.test(rendered), "pruned context has no dcp-message-id tags");
console.log("\npruned2 tokens:", estimateMessagesTokens(pruned2));

// 7. C4: nested compression that includes the prior summary, cited by content
//    anchors. The prior block is auto-detected (content text match) and folded.
state.lastContextMessages = pruned2;
const nestedCtx = buildRangeContext(pruned2, state);
const nestedArgs = {
  topic: "Wrap-up including prior block",
  content: [{ startAnchor: "Explored config.json", endAnchor: "Done.", summary: "Final wrap-up that also covers the earlier exploration block." }],
};
const nestedPlans = resolveRanges(nestedArgs, nestedCtx);
validateNonOverlapping(nestedPlans);
assert(nestedPlans[0].selection.requiredBlockIds.includes(1), "C4: prior block 1 auto-detected in cited range");
const nestedFolded = foldConsumedBlocks(nestedPlans[0].entry.summary, nestedPlans[0].selection.requiredBlockIds, nestedCtx.summaryByBlockId);
assert(nestedFolded.consumedBlockIds.includes(1), "C4: prior block 1 consumed/folded");
assert(/Explored config\.json/.test(nestedFolded.expandedSummary), "C4: prior block summary folded into new summary");
assert(/Final wrap-up/.test(nestedFolded.expandedSummary), "C4: new summary body preserved");
console.log("C4 nested consumed:", nestedFolded.consumedBlockIds);

// ---------------------------------------------------------------------------
// 8. Lifecycle: bind / flush / compact / model window / dirty
// ---------------------------------------------------------------------------
import {
  bindSession,
  flushSessionState,
  clearCompressionState,
  resolveSessionId,
  syncModelContextLimit,
  createSessionBeforeSwitchHandler,
  createSessionSwitchHandler,
  createSessionCompactHandler,
  createSessionShutdownHandler,
  createContextHandler,
} from "./src/hooks";
import { saveSessionState, loadSessionState, PERSIST_TYPE } from "./src/state/persistence";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "./src/omp";
import type { HandlerDeps } from "./src/hooks";

function makeCtx(opts: {
  sessionId?: string;
  sessionFile?: string;
  contextWindow?: number;
  branch?: SessionEntry[];
}): ExtensionContext {
  const branch = opts.branch ?? [];
  return {
    ui: { notify() {} },
    hasUI: false,
    cwd: ".",
    isIdle: () => true,
    model: opts.contextWindow ? { id: "test/model", contextWindow: opts.contextWindow } : undefined,
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => opts.sessionFile,
      getSessionId: () => opts.sessionId ?? "",
    },
  };
}

function makePi(appended: unknown[]): ExtensionAPI {
  return {
    zod: {} as ExtensionAPI["zod"],
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

// resolveSessionId prefers getSessionId over getSessionFile
{
  const ctx = makeCtx({ sessionId: "sid-abc", sessionFile: "/tmp/sess.jsonl" });
  assert(resolveSessionId(ctx) === "sid-abc", "resolveSessionId prefers getSessionId");
  const ctxFile = makeCtx({ sessionFile: "/tmp/only-file.jsonl" });
  // getSessionId returns "" → fall back to file
  assert(resolveSessionId(ctxFile) === "/tmp/only-file.jsonl", "resolveSessionId falls back to session file");
}

// syncModelContextLimit from ctx.model
{
  const s = createSessionState();
  syncModelContextLimit(s, makeCtx({ contextWindow: 128000 }));
  assert(s.modelContextLimit === 128000, "syncModelContextLimit reads ctx.model.contextWindow");
}

// bindSession: first bind + load from branch
{
  const s = createSessionState();
  // seed a prior compression into a fake branch entry
  const seed = createSessionState();
  seed.sessionId = "sess-1";
  seed.prune.messages.nextBlockId = 5;
  seed.prune.messages.activeBlockIds.add(4);
  seed.prune.messages.blocksById.set(4, {
    blockId: 4, runId: 1, active: true, deactivatedByUser: false,
    compressedTokens: 100, summaryTokens: 10, durationMs: 0, topic: "t",
    startId: "a", endId: "b", anchorMessageId: "a",
    includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
    directMessageIds: ["m1"], directToolIds: [],
    effectiveMessageIds: ["m1"], effectiveToolIds: [],
    createdAt: Date.now(), summary: "seed summary",
  });
  seed.dirty = true;
  const appended: unknown[] = [];
  const pi = makePi(appended);
  saveSessionState(pi, seed);
  assert(appended.length === 1, "saveSessionState appended one entry");
  assert(seed.dirty === false, "save clears dirty");

  const branch: SessionEntry[] = [{
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: PERSIST_TYPE,
    data: (appended[0] as { data: unknown }).data,
  }];

  const deps: HandlerDeps = {
    state: s,
    logger,
    config: DEFAULT_CONFIG,
    pi,
    counters: { contextFetch: 0 },
    systemInjectedFor: null,
  };
  bindSession(deps, makeCtx({ sessionId: "sess-1", contextWindow: 200000, branch }), "test-bind");
  assert(s.sessionId === "sess-1", "bind sets sessionId from getSessionId");
  assert(s.modelContextLimit === 200000, "bind syncs model window");
  assert(s.prune.messages.activeBlockIds.has(4), "bind loads active block from branch");
  assert(s.prune.messages.nextBlockId === 5, "bind restores nextBlockId");
  assert(s.dirty === false, "bind leaves state clean after load");
}

// bindSession switch: different id resets then loads empty
{
  const s = createSessionState();
  s.sessionId = "old";
  s.prune.messages.activeBlockIds.add(9);
  s.prune.messages.blocksById.set(9, {
    blockId: 9, runId: 1, active: true, deactivatedByUser: false,
    compressedTokens: 1, summaryTokens: 1, durationMs: 0, topic: "x",
    startId: "a", endId: "b", anchorMessageId: "a",
    includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
    directMessageIds: [], directToolIds: [],
    effectiveMessageIds: [], effectiveToolIds: [],
    createdAt: 0, summary: "gone",
  });
  const deps: HandlerDeps = {
    state: s,
    logger,
    config: DEFAULT_CONFIG,
    pi: makePi([]),
    counters: { contextFetch: 3 },
    systemInjectedFor: "old",
  };
  bindSession(deps, makeCtx({ sessionId: "new", branch: [] }), "test-switch");
  assert(s.sessionId === "new", "switch rebinds sessionId");
  assert(s.prune.messages.activeBlockIds.size === 0, "switch resets old blocks when new branch empty");
  assert(deps.counters.contextFetch === 0, "switch resets contextFetch counter");
}

// same-session rebind is a no-op (preserves in-flight dirty compress state)
{
  const s = createSessionState();
  s.sessionId = "same";
  s.prune.messages.activeBlockIds.add(1);
  s.dirty = true;
  const deps: HandlerDeps = {
    state: s, logger, config: DEFAULT_CONFIG, pi: makePi([]),
    counters: { contextFetch: 7 }, systemInjectedFor: "same",
  };
  bindSession(deps, makeCtx({ sessionId: "same", branch: [] }), "test-same");
  assert(s.prune.messages.activeBlockIds.has(1), "same-session bind keeps in-flight blocks");
  assert(s.dirty === true, "same-session bind does not clear dirty");
  assert(deps.counters.contextFetch === 7, "same-session bind keeps counters");
}

// flush on before_switch / shutdown only when dirty
{
  const appended: unknown[] = [];
  const s = createSessionState();
  s.sessionId = "flush-me";
  s.dirty = true;
  const deps: HandlerDeps = {
    state: s, logger, config: DEFAULT_CONFIG, pi: makePi(appended),
    counters: { contextFetch: 0 }, systemInjectedFor: null,
  };
  createSessionBeforeSwitchHandler(deps)({ type: "session_before_switch", reason: "new" }, makeCtx({ sessionId: "flush-me" }));
  assert(appended.length === 1, "session_before_switch flushes dirty state");
  assert(s.dirty === false, "flush clears dirty");

  // clean → no append
  createSessionShutdownHandler(deps)({ type: "session_shutdown" }, makeCtx({ sessionId: "flush-me" }));
  assert(appended.length === 1, "session_shutdown skips clean state");

  s.dirty = true;
  createSessionShutdownHandler(deps)({ type: "session_shutdown" }, makeCtx({ sessionId: "flush-me" }));
  assert(appended.length === 2, "session_shutdown flushes dirty state");
}

// session_compact clears blocks and persists
{
  const appended: unknown[] = [];
  const s = createSessionState();
  s.sessionId = "c";
  s.prune.messages.activeBlockIds.add(2);
  s.prune.messages.blocksById.set(2, {
    blockId: 2, runId: 1, active: true, deactivatedByUser: false,
    compressedTokens: 1, summaryTokens: 1, durationMs: 0, topic: "t",
    startId: "a", endId: "b", anchorMessageId: "a",
    includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
    directMessageIds: ["x"], directToolIds: [],
    effectiveMessageIds: ["x"], effectiveToolIds: [],
    createdAt: 0, summary: "y",
  });
  const deps: HandlerDeps = {
    state: s, logger, config: DEFAULT_CONFIG, pi: makePi(appended),
    counters: { contextFetch: 0 }, systemInjectedFor: null,
  };
  createSessionCompactHandler(deps)(
    { type: "session_compact", compactionEntry: { timestamp: "2026-07-21T00:00:00.000Z" }, fromExtension: false },
    makeCtx({ sessionId: "c", contextWindow: 64000 }),
  );
  assert(s.prune.messages.activeBlockIds.size === 0, "session_compact clears active blocks");
  assert(s.prune.messages.blocksById.size === 0, "session_compact clears blocksById");
  assert(appended.length === 1, "session_compact persists cleared state");
  assert(s.modelContextLimit === 64000, "session_compact still syncs model window");
  assert(s.lastCompaction > 0, "session_compact updates lastCompaction");
}

// context handler lazy-binds + uses ctx.model (not event.model)
{
  const s = createSessionState();
  assert(s.sessionId === null, "precondition: unbound");
  const deps: HandlerDeps = {
    state: s, logger, config: DEFAULT_CONFIG, pi: makePi([]),
    counters: { contextFetch: 0 }, systemInjectedFor: null,
  };
  const handler = createContextHandler(deps);
  const out = handler(
    { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
    makeCtx({ sessionId: "lazy", contextWindow: 99000, branch: [] }),
  );
  assert(s.sessionId === "lazy", "context lazy-binds session when unbound");
  assert(s.modelContextLimit === 99000, "context syncs window from ctx.model");
  assert(out && Array.isArray(out.messages), "context returns messages");
  assert(deps.counters.contextFetch === 1, "context increments fetch counter");
}

// clearCompressionState marks dirty
{
  const s = createSessionState();
  s.dirty = false;
  s.prune.messages.activeBlockIds.add(1);
  clearCompressionState(s);
  assert(s.dirty === true, "clearCompressionState marks dirty");
  assert(s.prune.messages.activeBlockIds.size === 0, "clearCompressionState empties blocks");
}

// loadSessionState must not clobber live sessionId
{
  const s = createSessionState();
  s.sessionId = "live-id";
  s.modelContextLimit = 111;
  const data = {
    v: 1 as const,
    sessionId: "stale-id",
    isSubAgent: false,
    manualMode: false as const,
    nextBlockId: 1,
    nextRunId: 1,
    nextRef: 1,
    lastCompaction: 0,
    currentTurn: 0,
    modelContextLimit: 999,
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    maps: {
      pruneTools: [] as [string, number][],
      byMessageId: [] as [string, never][],
      blocksById: [] as [number, never][],
      activeBlockIds: [] as number[],
      activeByAnchorMessageId: [] as [string, number][],
      toolParameters: [] as [string, never][],
      toolIdList: [] as string[],
      byRawId: [] as [string, string][],
      byRef: [] as [string, string][],
    },
  };
  const entries: SessionEntry[] = [{
    type: "custom", id: "x", parentId: null, timestamp: new Date().toISOString(),
    customType: PERSIST_TYPE, data,
  }];
  const ok = loadSessionState(entries, s);
  assert(ok, "loadSessionState succeeds");
  assert(s.sessionId === "live-id", "load does not overwrite live sessionId");
  assert(s.modelContextLimit === 111, "load does not overwrite live model window");
}

console.log("\nlifecycle checks passed");
