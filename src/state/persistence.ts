import type { SessionState, CompressionBlock, PrunedMessageEntry, ToolParameterEntry } from "./types";
import type { SessionEntry, CustomEntry, ExtensionAPI } from "../omp";

const PERSIST_TYPE = "dcp-state";

interface SerializedMaps {
  pruneTools: [string, number][];
  byMessageId: [string, PrunedMessageEntry][];
  blocksById: [number, CompressionBlock][];
  activeBlockIds: number[];
  activeByAnchorMessageId: [string, number][];
  toolParameters: [string, ToolParameterEntry][];
  toolIdList: string[];
  byRawId: [string, string][];
  byRef: [string, string][];
}

interface SerializedState {
  v: 1;
  sessionId: string | null;
  isSubAgent: boolean;
  manualMode: SessionState["manualMode"];
  nextBlockId: number;
  nextRunId: number;
  nextRef: number;
  lastCompaction: number;
  currentTurn: number;
  modelContextLimit: number | undefined;
  stats: SessionState["stats"];
  maps: SerializedMaps;
  /** Compression blocks survive a reload; ephemeral nudges/pending do not. */
}

function serialize(state: SessionState): SerializedState {
  const m = state.prune.messages;
  return {
    v: 1,
    sessionId: state.sessionId,
    isSubAgent: state.isSubAgent,
    manualMode: state.manualMode,
    nextBlockId: m.nextBlockId,
    nextRunId: m.nextRunId,
    nextRef: state.messageIds.nextRef,
    lastCompaction: state.lastCompaction,
    currentTurn: state.currentTurn,
    modelContextLimit: state.modelContextLimit,
    stats: state.stats,
    maps: {
      pruneTools: [...state.prune.tools],
      byMessageId: [...m.byMessageId],
      blocksById: [...m.blocksById],
      activeBlockIds: [...m.activeBlockIds],
      activeByAnchorMessageId: [...m.activeByAnchorMessageId],
      toolParameters: [...state.toolParameters],
      toolIdList: state.toolIdList,
      byRawId: [...state.messageIds.byRawId],
      byRef: [...state.messageIds.byRef],
    },
  };
}

function isCustomEntry(e: SessionEntry): e is CustomEntry {
  return (e as SessionEntry).type === "custom";
}

export function saveSessionState(pi: ExtensionAPI, state: SessionState): void {
  try {
    const data = serialize(state);
    const result = pi.appendEntry(PERSIST_TYPE, data);
    state.dirty = false;
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch(() => {
        /* persistence must never break the session — re-mark dirty so a later flush retries */
        state.dirty = true;
      });
    }
  } catch {
    state.dirty = true;
  }
}

/**
 * Reconstruct durable state from the latest `dcp-state` custom entry on the
 * active branch. Called on `session_start`. Ephemeral turn/nudge caches reset.
 */
export function loadSessionState(entries: SessionEntry[], state: SessionState): boolean {
  let latest: CustomEntry | null = null;
  for (const entry of entries) {
    if (isCustomEntry(entry) && entry.customType === PERSIST_TYPE) {
      latest = entry;
    }
  }
  if (!latest) return false;

  const data = latest.data as SerializedState | undefined;
  if (!data || data.v !== 1) return false;

  // Keep the live session binding from bindSession; stored sessionId is advisory only.
  // (Serialized id may be a prior path/id shape and must not unbind the current session.)
  state.isSubAgent = data.isSubAgent ?? false;
  state.manualMode = data.manualMode ?? false;
  state.lastCompaction = data.lastCompaction ?? 0;
  state.currentTurn = data.currentTurn ?? 0;
  // Prefer a previously-synced live model window over a stale persisted one.
  if (state.modelContextLimit === undefined && data.modelContextLimit !== undefined) {
    state.modelContextLimit = data.modelContextLimit;
  }
  state.stats = data.stats ?? { pruneTokenCounter: 0, totalPruneTokens: 0 };

  const maps = data.maps;
  state.prune.tools = new Map(maps.pruneTools);
  state.prune.messages = {
    byMessageId: new Map(maps.byMessageId),
    blocksById: new Map(maps.blocksById),
    activeBlockIds: new Set(maps.activeBlockIds),
    activeByAnchorMessageId: new Map(maps.activeByAnchorMessageId),
    nextBlockId: data.nextBlockId ?? 1,
    nextRunId: data.nextRunId ?? 1,
  };
  state.toolParameters = new Map(maps.toolParameters);
  state.toolIdList = maps.toolIdList ?? [];
  state.messageIds = {
    byRawId: new Map(maps.byRawId),
    byRef: new Map(maps.byRef),
    nextRef: data.nextRef ?? 1,
  };
  // ephemeral caches are rebuilt per-session
  state.nudges = { contextLimitAnchors: new Set(), turnNudgeAnchors: new Set(), iterationNudgeAnchors: new Set() };
  state.pendingManualTrigger = null;
  state.lastContextMessages = null;
  state.dirty = false;

  return true;
}

export { PERSIST_TYPE };
