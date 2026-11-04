/**
 * Session state and persistence.
 *
 * The only durable state is the set of compression blocks. Anchors need no
 * persistence of their own — they are re-derived by scanning the session
 * history for add_anchor tool calls (tool-call ids are stable across reloads).
 *
 * Blocks form a **chain**: a compression that absorbs a prior block records it
 * in `parentIds` and marks the parent `supersededBy`. The parent's text is
 * never deleted — it stops driving the transform (its span already lies inside
 * the child's) but stays recallable through `expand`. That is what makes
 * loss-free merging unnecessary: the model writes the summary it can write, and
 * whatever it leaves out is still one `expand` away.
 *
 * Persistence rides omp's custom session entries (`dcp-state`, v5): the latest
 * entry on the active branch wins. v4 entries (pre-chain, absorbed blocks
 * deleted) are migrated with empty `parentIds`; v1–v3 are ignored.
 */

import type { CustomEntry, ExtensionAPI, SessionEntry } from "./omp";

export const PERSIST_TYPE = "dcp-state";
const PERSIST_VERSION = 6;
/** Oldest version whose block list can be migrated (chain-less but intact). */
const MIGRATABLE_VERSION = 4;
/** First version whose blocks carry chain fields (`parentIds` / `supersededBy`). */
const CHAIN_VERSION = 5;

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
  /** Blocks this one absorbed, oldest last. Their text stays recallable. */
  parentIds: number[];
  /** id of the block that absorbed this one; null while the block is live. */
  supersededBy: number | null;
  createdAt: number;
}

export interface SessionState {
  sessionId: string | null;
  blocks: CompressionBlock[];
  nextBlockId: number;
  /** Timestamp of the latest omp compaction entry seen; blocks die on compaction. */
  lastCompaction: number;
  /**
   * Provider-reported token total at the moment of the last compression. That
   * usage report describes the pre-compression context, so until the next
   * request reports a fresh one the estimate must not anchor on it — otherwise
   * the first request after every compression claims the old (huge) size and
   * fires the token reminder for a context that was just pruned.
   */
  usageMark: number;
  /**
   * Highest 10%-of-window bracket already reported by `[dcp:context]`. The
   * reminder is stateless without it: every request re-estimates and fires
   * again while the same context sits above the threshold, which reads as
   * spam. Reset to 0 once the estimate drops back under the threshold.
   */
  remindLevel: number;
  /** Durable divergence from the last persisted dcp-state entry. */
  dirty: boolean;
}

export function createSessionState(): SessionState {
  return {
    sessionId: null,
    blocks: [],
    nextBlockId: 1,
    lastCompaction: 0,
    usageMark: 0,
    remindLevel: 0,
    dirty: false,
  };
}

/** Full per-session wipe. Callers switching sessions MUST load afterwards. */
export function resetForSession(state: SessionState, sessionId: string): void {
  state.sessionId = sessionId;
  state.blocks = [];
  state.nextBlockId = 1;
  state.lastCompaction = 0;
  state.usageMark = 0;
  state.remindLevel = 0;
  state.dirty = false;
}

interface SerializedState {
  v: number;
  sessionId: string | null;
  nextBlockId: number;
  blocks: CompressionBlock[];
  usageMark: number;
  remindLevel: number;
}

export function saveSessionState(pi: ExtensionAPI, state: SessionState): void {
  try {
    const data: SerializedState = {
      v: PERSIST_VERSION,
      sessionId: state.sessionId,
      nextBlockId: state.nextBlockId,
      blocks: state.blocks,
      usageMark: state.usageMark,
      remindLevel: state.remindLevel,
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

/** Block shape shared by v4 and v5 (chain fields optional for migration). */
function isValidBlock(value: unknown): value is CompressionBlock {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "number") return false;
  if (!("startName" in value) || typeof value.startName !== "string") return false;
  if (!("startToolCallId" in value) || (typeof value.startToolCallId !== "string" && value.startToolCallId !== null)) return false;
  if (!("summary" in value) || typeof value.summary !== "string") return false;
  if (!("compressCallId" in value) || typeof value.compressCallId !== "string") return false;
  return true;
}

/** v4 blocks carry no chain fields; a v5 block must declare them. */
function migrateBlock(value: CompressionBlock, version: number): CompressionBlock {
  const parents = "parentIds" in value && Array.isArray(value.parentIds) ? value.parentIds.filter((n) => typeof n === "number") : [];
  const superseded = "supersededBy" in value && (typeof value.supersededBy === "number" || value.supersededBy === null) ? value.supersededBy : null;
  return {
    id: value.id,
    startName: value.startName,
    startToolCallId: value.startToolCallId,
    summary: value.summary,
    compressCallId: value.compressCallId,
    parentIds: version >= CHAIN_VERSION ? parents : [],
    supersededBy: version >= CHAIN_VERSION ? superseded : null,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
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
  if (!("v" in data) || typeof data.v !== "number") return false;
  if (!(data.v >= MIGRATABLE_VERSION && data.v <= PERSIST_VERSION)) return false;
  if (!("blocks" in data) || !Array.isArray(data.blocks)) return false;

  const version = data.v;
  const blocks = (data.blocks as unknown[]).filter(isValidBlock).map((b) => migrateBlock(b, version));
  state.blocks = blocks;
  const maxId = blocks.reduce((max, b) => Math.max(max, b.id), 0);
  state.nextBlockId =
    "nextBlockId" in data && typeof data.nextBlockId === "number" && data.nextBlockId > maxId
      ? data.nextBlockId
      : maxId + 1;
  state.usageMark = "usageMark" in data && typeof data.usageMark === "number" && data.usageMark >= 0 ? data.usageMark : 0;
  state.remindLevel =
    "remindLevel" in data && typeof data.remindLevel === "number" && data.remindLevel >= 0 ? data.remindLevel : 0;
  state.dirty = false;
  return true;
}

// ---------------------------------------------------------------------------
// chain helpers
// ---------------------------------------------------------------------------

/** Live (not superseded) blocks, in creation order. */
export function activeBlocks(blocks: CompressionBlock[]): CompressionBlock[] {
  return blocks.filter((b) => b.supersededBy === null);
}

/** Block by id, or undefined. */
export function findBlock(blocks: CompressionBlock[], id: number): CompressionBlock | undefined {
  return blocks.find((b) => b.id === id);
}

/**
 * Full ancestry of a block, nearest parent first. Cycles are impossible by
 * construction (a parent always has a smaller id) but the traversal still
 * guards against corrupt state.
 */
export function ancestorsOf(blocks: CompressionBlock[], block: CompressionBlock): CompressionBlock[] {
  const out: CompressionBlock[] = [];
  const seen = new Set<number>([block.id]);
  let frontier = [...block.parentIds].reverse();
  while (frontier.length > 0) {
    const id = frontier.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = findBlock(blocks, id);
    if (!parent) continue;
    out.push(parent);
    frontier = [...parent.parentIds].reverse().concat(frontier);
  }
  return out;
}
