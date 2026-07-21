import type { SessionState } from "./types";

export function createSessionState(): SessionState {
  return {
    sessionId: null,
    isSubAgent: false,
    manualMode: false,
    pendingManualTrigger: null,
    prune: {
      tools: new Map(),
      messages: {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
      },
    },
    nudges: {
      contextLimitAnchors: new Set(),
      turnNudgeAnchors: new Set(),
      iterationNudgeAnchors: new Set(),
    },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    toolParameters: new Map(),
    toolIdList: [],
    messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
    lastCompaction: 0,
    currentTurn: 0,
    modelContextLimit: undefined,
    lastContextMessages: null,
    dirty: false,
  };
}

/**
 * Full per-session wipe (durable compression blocks included). Callers that
 * switch sessions MUST `loadSessionState` afterwards to restore any persisted
 * dcp-state for the new session. Ephemeral caches are always rebuilt.
 */
export function resetForSession(state: SessionState, sessionId: string): void {
  state.sessionId = sessionId;
  state.isSubAgent = false;
  state.manualMode = false;
  state.pendingManualTrigger = null;
  state.prune = {
    tools: new Map(),
    messages: {
      byMessageId: new Map(),
      blocksById: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      nextBlockId: 1,
      nextRunId: 1,
    },
  };
  state.nudges = {
    contextLimitAnchors: new Set(),
    turnNudgeAnchors: new Set(),
    iterationNudgeAnchors: new Set(),
  };
  state.stats = { pruneTokenCounter: 0, totalPruneTokens: 0 };
  state.toolParameters = new Map();
  state.toolIdList = [];
  state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 };
  state.lastCompaction = 0;
  state.currentTurn = 0;
  state.lastContextMessages = null;
  state.dirty = false;
}
