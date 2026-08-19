/**
 * Session state and persistence.
 *
 * The only durable state is the list of compression blocks. Anchors need no
 * persistence of their own — they are re-derived by scanning the session
 * history for add_anchor tool calls (tool-call ids are stable across reloads).
 *
 * Persistence rides omp's custom session entries (`dcp-state`, v4): the latest
 * entry on the active branch wins. Older versions (and malformed blocks) are
 * ignored.
 */

import type { CustomEntry, ExtensionAPI, SessionEntry } from "./omp";

export const PERSIST_TYPE = "dcp-state";
const PERSIST_VERSION = 4;

export interface CompressionBlock {
  id: number;
  /** Anchor name as the model cited it (display / error messages). */
  startName: string;
  /** tool-call id of the start add_anchor call; null for session_start. */
  startToolCallId: string | null;
  /** Model-authored summary replacing the span. */
  summary: string;
  /**
   * tool-call id of the compress call itself — the implicit end of the span.
   * The call and its toolResult stay in context right after the summary.
   */
  compressCallId: string;
  createdAt: number;
}

export interface SessionState {
  sessionId: string | null;
  blocks: CompressionBlock[];
  nextBlockId: number;
  /** Timestamp of the latest omp compaction entry seen; blocks die on compaction. */
  lastCompaction: number;
  /** Durable divergence from the last persisted dcp-state entry. */
  dirty: boolean;
}

export function createSessionState(): SessionState {
  return {
    sessionId: null,
    blocks: [],
    nextBlockId: 1,
    lastCompaction: 0,
    dirty: false,
  };
}

/** Full per-session wipe. Callers switching sessions MUST load afterwards. */
export function resetForSession(state: SessionState, sessionId: string): void {
  state.sessionId = sessionId;
  state.blocks = [];
  state.nextBlockId = 1;
  state.lastCompaction = 0;
  state.dirty = false;
}

interface SerializedState {
  v: number;
  sessionId: string | null;
  nextBlockId: number;
  blocks: CompressionBlock[];
}

export function saveSessionState(pi: ExtensionAPI, state: SessionState): void {
  try {
    const data: SerializedState = {
      v: PERSIST_VERSION,
      sessionId: state.sessionId,
      nextBlockId: state.nextBlockId,
      blocks: state.blocks,
    };
    const result = pi.appendEntry(PERSIST_TYPE, data);
    state.dirty = false;
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch(() => {
        // Persistence must never break the session — re-mark dirty so a later flush retries.
        state.dirty = true;
      });
    }
  } catch {
    state.dirty = true;
  }
}

function isCustomEntry(entry: SessionEntry): entry is CustomEntry {
  return entry.type === "custom";
}

function isValidBlock(value: unknown): value is CompressionBlock {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "number") return false;
  if (!("startName" in value) || typeof value.startName !== "string") return false;
  if (!("startToolCallId" in value) || (typeof value.startToolCallId !== "string" && value.startToolCallId !== null)) return false;
  if (!("summary" in value) || typeof value.summary !== "string") return false;
  if (!("compressCallId" in value) || typeof value.compressCallId !== "string") return false;
  return true;
}

/**
 * Reconstruct durable state from the latest dcp-state entry on the branch.
 * Blocks whose anchors no longer resolve are pruned lazily at transform time.
 */
export function loadSessionState(entries: SessionEntry[], state: SessionState): boolean {
  let latest: CustomEntry | null = null;
  for (const entry of entries) {
    if (isCustomEntry(entry) && entry.customType === PERSIST_TYPE) latest = entry;
  }
  if (!latest) return false;

  const data: unknown = latest.data;
  if (typeof data !== "object" || data === null) return false;
  if (!("v" in data) || data.v !== PERSIST_VERSION) return false;
  if (!("blocks" in data) || !Array.isArray(data.blocks)) return false;

  const blocks = data.blocks.filter(isValidBlock);
  state.blocks = blocks;
  const maxId = blocks.reduce((max, b) => Math.max(max, b.id), 0);
  state.nextBlockId =
    "nextBlockId" in data && typeof data.nextBlockId === "number" && data.nextBlockId > maxId
      ? data.nextBlockId
      : maxId + 1;
  state.dirty = false;
  return true;
}
