/**
 * omp event handlers wiring the anchor-compression pipeline into the session.
 *
 *   session_start / session_switch   → bind (reset on id change) + load dcp-state
 *   session_before_switch / shutdown → flush dirty state into the current session
 *   session_compact                  → drop all blocks (anchors may be compacted away)
 *   context                          → lazy bind, reconcile omp compaction, transform
 *
 * The context handler is the heart: it applies compression blocks to a deep
 * clone of the outgoing messages — session storage is never modified.
 */

import type {
  AgentMessage,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionCompactEvent,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionSwitchEvent,
} from "./omp";
import type { Logger } from "./logger";
import type { SessionState } from "./state";
import { loadSessionState, resetForSession, saveSessionState } from "./state";
import { applyCompressions } from "./transform";
import { maybeAppendReminder, type RemindPolicy } from "./remind";

export interface HandlerDeps {
  state: SessionState;
  logger: Logger;
  pi: ExtensionAPI;
  /** When to nudge the model to compress (token budget, tool-call budget). */
  remind: RemindPolicy;
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

function latestCompactionTimestamp(entries: SessionEntry[]): number {
  let latest = 0;
  for (const e of entries) {
    if (e.type !== "compaction") continue;
    const t = Date.parse(e.timestamp ?? "");
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

function getBranch(ctx: ExtensionContext): SessionEntry[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }
}

/** Drop all compression blocks; anchors may no longer resolve post-compaction. */
export function clearCompressionState(state: SessionState): void {
  state.blocks = [];
  state.dirty = true;
}

/** If omp ran its own compaction since our last pass, blocks reference gone messages. */
function reconcileOmpCompaction(deps: HandlerDeps, entries: SessionEntry[]): void {
  const latest = latestCompactionTimestamp(entries);
  if (latest > 0 && latest > deps.state.lastCompaction) {
    deps.logger.info("omp compaction detected; clearing compression state", {
      latest,
      prev: deps.state.lastCompaction,
    });
    clearCompressionState(deps.state);
    deps.state.lastCompaction = latest;
  }
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  // Deep-clone content blocks: the transform strips blocks in place on the
  // array it is given. omp may reuse block objects across calls — originals
  // must stay byte-for-byte intact.
  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => structuredClone(b)) : m.content,
  }));
}

/**
 * Bind state to the current omp session. Same-session re-entry is a no-op so
 * in-flight compress state is never wiped; a different id resets and reloads
 * from the branch's latest dcp-state entry.
 */
export function bindSession(deps: HandlerDeps, ctx: ExtensionContext, source: string): void {
  const resolved = resolveSessionId(ctx) ?? "";
  if (deps.state.sessionId !== null && deps.state.sessionId === resolved) {
    deps.logger.debug("bind same session; skip reset", { sessionId: resolved, source });
    return;
  }

  deps.logger.info("session bind", { from: deps.state.sessionId, to: resolved, source });
  resetForSession(deps.state, resolved);

  const entries = getBranch(ctx);
  const loaded = loadSessionState(entries, deps.state);
  deps.state.lastCompaction = latestCompactionTimestamp(entries);
  deps.state.dirty = false;

  deps.logger.info("state loaded", {
    sessionId: deps.state.sessionId,
    loaded,
    blocks: deps.state.blocks.length,
    source,
  });
}

/** Flush dirty durable state into the *current* session before it is abandoned. */
export function flushSessionState(deps: HandlerDeps, reason: string): void {
  if (!deps.state.dirty) {
    deps.logger.debug("flush skipped (clean)", { reason, sessionId: deps.state.sessionId });
    return;
  }
  deps.logger.info("flush", { reason, sessionId: deps.state.sessionId });
  saveSessionState(deps.pi, deps.state);
}

export function createContextHandler(deps: HandlerDeps) {
  return (event: ContextEvent, ctx: ExtensionContext): { messages: AgentMessage[] } => {
    if (deps.state.sessionId === null) {
      bindSession(deps, ctx, "context-lazy");
    }
    reconcileOmpCompaction(deps, getBranch(ctx));

    const messages = cloneMessages(event.messages ?? []);
    const transformed = applyCompressions(deps.state, deps.logger, messages);
    const outgoing = maybeAppendReminder(transformed, ctx, deps.remind, deps.state.toolCallMark);
    deps.logger.saveContext(deps.state.sessionId ?? "session", outgoing);
    return { messages: outgoing };
  };
}

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
    flushSessionState(deps, "session_before_switch");
  };
}

export function createSessionShutdownHandler(deps: HandlerDeps) {
  return (_event: SessionShutdownEvent, _ctx: ExtensionContext): void => {
    flushSessionState(deps, "session_shutdown");
  };
}

export function createSessionCompactHandler(deps: HandlerDeps) {
  return (event: SessionCompactEvent, _ctx: ExtensionContext): void => {
    const ts = Date.parse(event.compactionEntry?.timestamp ?? "") || Date.now();
    deps.logger.info("session_compact; clearing compression state", { ts, fromExtension: event.fromExtension });
    clearCompressionState(deps.state);
    deps.state.lastCompaction = Math.max(deps.state.lastCompaction, ts);
    // Persist cleared state so resume does not resurrect dead blocks.
    saveSessionState(deps.pi, deps.state);
  };
}
