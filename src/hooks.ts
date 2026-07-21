/**
 * omp event handlers wiring the DCP pipeline into the live session.
 *
 * `createContextHandler` is the heart: every provider request it rebuilds
 * tool metadata, runs the strategies, assigns m-refs, prunes, and nudges — on a
 * clone of the messages, never touching storage.
 *
 * Session binding follows omp's real lifecycle:
 *   session_start / session_switch  → reset (if id changed) + load dcp-state
 *   session_before_switch / session_shutdown → flush dirty state into the
 *     *current* session file before it goes away
 *   session_compact → drop compression blocks that reference compacted-away msgs
 *
 * Model context window comes from `ctx.model` (and `getContextUsage` fallback),
 * never from event payloads — ContextEvent / TurnEndEvent do not carry model.
 */

import type {
  AgentMessage,
  ExtensionAPI,
  ContextEvent,
  ExtensionContext,
  SessionEntry,
  SessionStartEvent,
  SessionSwitchEvent,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionCompactEvent,
  TurnEndEvent,
} from "./omp";
import type { PluginConfig } from "./config";
import type { Logger } from "./logger";
import type { SessionState } from "./state/types";
import { resetForSession } from "./state/state";
import { loadSessionState, saveSessionState } from "./state/persistence";
import { buildToolMetadata, countUserTurns } from "./messages/query";
import { assignMessageRefs } from "./messages/identity";
import { prune } from "./messages/prune";
import { injectCompressNudges } from "./messages/nudge";
import { deduplicate } from "./strategies/deduplication";
import { purgeErrors } from "./strategies/purge-errors";
import { estimateMessagesTokens } from "./token-utils";
import { SYSTEM_PROMPT_BLOCK } from "./prompts";

export interface HandlerDeps {
  state: SessionState;
  logger: Logger;
  config: PluginConfig;
  pi: ExtensionAPI;
  counters: { contextFetch: number };
  systemInjectedFor: string | null;
}

/** Prefer stable session id; fall back to session file path for ephemeral hosts. */
export function resolveSessionId(ctx: ExtensionContext): string | null {
  const sm = ctx.sessionManager;
  if (!sm) return null;
  try {
    if (typeof sm.getSessionId === "function") {
      const id = sm.getSessionId();
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof sm.getSessionFile === "function") {
      const file = sm.getSessionFile();
      if (typeof file === "string" && file.length > 0) return file;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Pull model context window from the live ExtensionContext. */
export function syncModelContextLimit(state: SessionState, ctx: ExtensionContext): void {
  const fromModel = ctx.model?.contextWindow;
  if (typeof fromModel === "number" && fromModel > 0) {
    state.modelContextLimit = fromModel;
    return;
  }
  try {
    const usage = ctx.getContextUsage?.();
    const limit = usage?.limit;
    if (typeof limit === "number" && limit > 0) {
      state.modelContextLimit = limit;
    }
  } catch {
    /* ignore */
  }
}

function isCompactionEntry(e: SessionEntry): boolean {
  return (e as { type?: string }).type === "compaction";
}

function latestCompactionTimestamp(entries: SessionEntry[]): number {
  let latest = 0;
  for (const e of entries) {
    if (isCompactionEntry(e)) {
      const t = Date.parse((e as { timestamp?: string }).timestamp ?? "");
      if (Number.isFinite(t) && t > latest) latest = t;
    }
  }
  return latest;
}

/** Drop all active compression/prune-tool marks; identities no longer match post-compact context. */
export function clearCompressionState(state: SessionState): void {
  state.prune.messages = {
    byMessageId: new Map(),
    blocksById: new Map(),
    activeBlockIds: new Set(),
    activeByAnchorMessageId: new Map(),
    nextBlockId: 1,
    nextRunId: 1,
  };
  state.prune.tools = new Map();
  state.lastContextMessages = null;
  state.dirty = true;
}

/** If omp ran its own compaction since our last pass, compression blocks reference gone messages. */
function reconcileOmpCompaction(deps: HandlerDeps, entries: SessionEntry[]): void {
  const latest = latestCompactionTimestamp(entries);
  if (latest > 0 && latest > deps.state.lastCompaction) {
    deps.logger.info("omp compaction detected; clearing DCP compression state", {
      latest,
      prev: deps.state.lastCompaction,
    });
    clearCompressionState(deps.state);
    deps.state.lastCompaction = latest;
  }
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  // Deep-clone each message and its content blocks: prune / assignMessageRefs /
  // nudge mutate block fields in place (block.text, block.content, tool_use
  // input). omp may reuse block objects across calls, so we must not touch the
  // originals — storage stays byte-for-byte intact.
  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => structuredClone(b)) : m.content,
  }));
}

function getBranch(ctx: ExtensionContext): SessionEntry[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Bind DCP state to the current omp session.
 *
 * Same session id → refresh model window only (do not wipe in-flight state).
 * Different / first bind → reset ephemeral+durable maps, then load dcp-state
 * from the active branch.
 */
export function bindSession(deps: HandlerDeps, ctx: ExtensionContext, source: string): void {
  if (!deps.config.enabled) return;

  const sessionId = resolveSessionId(ctx);
  const prev = deps.state.sessionId;
  const isSwitch = prev !== null && sessionId !== null && prev !== sessionId;
  const isFirst = prev === null;

  syncModelContextLimit(deps.state, ctx);

  if (!isFirst && !isSwitch && sessionId === prev) {
    // Same session re-entry (e.g. both session_start and a later redundant bind).
    deps.logger.debug("DCP bind same session; skip reset", { sessionId, source });
    return;
  }

  if (isSwitch) {
    deps.logger.info("DCP session switch", { from: prev, to: sessionId, source });
  } else {
    deps.logger.info("DCP session bind", { sessionId, source });
  }

  resetForSession(deps.state, sessionId ?? "");
  deps.counters.contextFetch = 0;

  const entries = getBranch(ctx);
  const loaded = loadSessionState(entries, deps.state);
  deps.state.lastCompaction = latestCompactionTimestamp(entries);
  // Fresh bind is clean relative to whatever we just loaded (or empty).
  deps.state.dirty = false;

  deps.logger.info("DCP state loaded", {
    sessionId: deps.state.sessionId,
    loaded,
    activeBlocks: deps.state.prune.messages.activeBlockIds.size,
    source,
  });

  // One-time DCP orientation message per session id.
  if (deps.config.compress.permission !== "deny" && sessionId && deps.systemInjectedFor !== sessionId) {
    deps.systemInjectedFor = sessionId;
    try {
      deps.pi.sendCustomMessage?.(
        { customType: "dcp-system", content: SYSTEM_PROMPT_BLOCK, display: false, attribution: "agent" },
        { deliverAs: "nextTurn" },
      );
    } catch {
      /* best-effort */
    }
  }
}

/** Flush dirty durable state into the *current* session before it is abandoned. */
export function flushSessionState(deps: HandlerDeps, reason: string): void {
  if (!deps.config.enabled) return;
  if (!deps.state.dirty && deps.state.sessionId === null) return;
  if (!deps.state.dirty) {
    deps.logger.debug("DCP flush skipped (clean)", { reason, sessionId: deps.state.sessionId });
    return;
  }
  deps.logger.info("DCP flush", { reason, sessionId: deps.state.sessionId });
  saveSessionState(deps.pi, deps.state);
}

export function createContextHandler(deps: HandlerDeps) {
  return (event: ContextEvent, ctx: ExtensionContext): { messages: AgentMessage[] } | void => {
    if (!deps.config.enabled) return;
    if (deps.state.isSubAgent && !deps.config.experimental.allowSubAgents) return;

    // Lazy bind: if session_start was missed, bind on first context pass.
    if (deps.state.sessionId === null) {
      bindSession(deps, ctx, "context-lazy");
    } else {
      syncModelContextLimit(deps.state, ctx);
    }

    const entries = getBranch(ctx);
    reconcileOmpCompaction(deps, entries);

    const messages = cloneMessages(event.messages ?? []);

    buildToolMetadata(deps.state, messages);
    deps.state.currentTurn = countUserTurns(messages);

    // strategies recompute transient prune.tools each pass
    deps.state.prune.tools = new Map();
    deduplicate(deps.state, deps.config, deps.logger);
    purgeErrors(deps.state, deps.config, deps.logger);

    assignMessageRefs(deps.state, messages);
    const pruned = prune(deps.state, deps.logger, deps.config, messages);
    // Stash the POST-prune array: it is exactly what the model sees, so the
    // content anchors the model quotes match what the compress tool resolves.
    deps.state.lastContextMessages = pruned;

    deps.counters.contextFetch += 1;
    injectCompressNudges(deps.state, deps.config, estimateMessagesTokens(pruned), pruned, deps.counters.contextFetch);

    deps.logger.saveContext(deps.state.sessionId ?? "session", pruned);
    return { messages: pruned };
  };
}

/** @deprecated name kept as alias for older imports / smoke harnesses */
export const createContextMenuHandler = createContextHandler;

export function createSessionStartHandler(deps: HandlerDeps) {
  return (_event: SessionStartEvent, ctx: ExtensionContext): void => {
    bindSession(deps, ctx, "session_start");
  };
}

export function createSessionSwitchHandler(deps: HandlerDeps) {
  return (event: SessionSwitchEvent, ctx: ExtensionContext): void => {
    bindSession(deps, ctx, `session_switch:${event.reason}`);
  };
}

export function createSessionBeforeSwitchHandler(deps: HandlerDeps) {
  return (_event: SessionBeforeSwitchEvent, _ctx: ExtensionContext): void => {
    // Still pointing at the *old* session file — flush before host swaps it.
    flushSessionState(deps, "session_before_switch");
  };
}

export function createSessionShutdownHandler(deps: HandlerDeps) {
  return (_event: SessionShutdownEvent, _ctx: ExtensionContext): void => {
    flushSessionState(deps, "session_shutdown");
  };
}

export function createSessionCompactHandler(deps: HandlerDeps) {
  return (event: SessionCompactEvent, ctx: ExtensionContext): void => {
    if (!deps.config.enabled) return;
    const ts = Date.parse(event.compactionEntry?.timestamp ?? "") || Date.now();
    deps.logger.info("session_compact; clearing DCP compression state", {
      fromExtension: event.fromExtension,
      ts,
    });
    clearCompressionState(deps.state);
    deps.state.lastCompaction = Math.max(deps.state.lastCompaction, ts);
    // Persist cleared state so resume does not resurrect dead blocks.
    saveSessionState(deps.pi, deps.state);
    syncModelContextLimit(deps.state, ctx);
  };
}

export function createTurnEndHandler(deps: HandlerDeps) {
  return (_event: TurnEndEvent, ctx: ExtensionContext): void => {
    syncModelContextLimit(deps.state, ctx);
  };
}

export { saveSessionState };
