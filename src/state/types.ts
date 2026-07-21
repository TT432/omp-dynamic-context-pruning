import type { AgentMessage } from "../omp";
/**
 * Session state model, adapted from DCP's `lib/state/types.ts`.
 *
 * omp messages carry no stable id (the id lives on the session entry), so the
 * maps that DCP keyed on `message.info.id` are instead keyed on a derived
 * content identity string (see `messages/identity.ts`). Tool-call maps stay
 * keyed on `tool_use.id`, which is stable.
 */

export type CompressionMode = "range" | "message";
export type ManualMode = false | "active" | "compress-pending";

export interface ToolParameterEntry {
  tool: string;
  parameters: unknown;
  status?: "pending" | "running" | "completed" | "error";
  error?: string;
  turn: number;
  tokenCount?: number;
}

export interface SessionStats {
  pruneTokenCounter: number;
  totalPruneTokens: number;
}

export interface PrunedMessageEntry {
  tokenCount: number;
  allBlockIds: number[];
  activeBlockIds: number[];
}

export interface CompressionBlock {
  blockId: number;
  runId: number;
  active: boolean;
  deactivatedByUser: boolean;
  compressedTokens: number;
  summaryTokens: number;
  durationMs: number;
  mode?: CompressionMode;
  topic: string;
  batchTopic?: string;
  startId: string;
  endId: string;
  /** Identity of the message at which the summary is injected. */
  anchorMessageId: string;
  /** The assistant message id produced by the compress tool call (best-effort). */
  compressMessageId?: string;
  compressCallId?: string;
  includedBlockIds: number[];
  consumedBlockIds: number[];
  parentBlockIds: number[];
  directMessageIds: string[];
  directToolIds: string[];
  effectiveMessageIds: string[];
  effectiveToolIds: string[];
  createdAt: number;
  deactivatedAt?: number;
  deactivatedByBlockId?: number;
  summary: string;
}

export interface PruneMessagesState {
  /** content-identity -> prune entry */
  byMessageId: Map<string, PrunedMessageEntry>;
  blocksById: Map<number, CompressionBlock>;
  activeBlockIds: Set<number>;
  /** anchor message identity -> active block id */
  activeByAnchorMessageId: Map<string, number>;
  nextBlockId: number;
  nextRunId: number;
}

export interface PruneState {
  /** tool_use.id -> token estimate (kept for stats once pruned) */
  tools: Map<string, number>;
  messages: PruneMessagesState;
}

export interface PendingManualTrigger {
  sessionId: string;
  prompt: string;
}

/** ref (m0001) -> stable content identity */
export interface MessageIdState {
  byRawId: Map<string, string>;
  byRef: Map<string, string>;
  nextRef: number;
}

export interface Nudges {
  contextLimitAnchors: Set<string>;
  turnNudgeAnchors: Set<string>;
  iterationNudgeAnchors: Set<string>;
}

export interface SessionState {
  sessionId: string | null;
  isSubAgent: boolean;
  manualMode: ManualMode;
  pendingManualTrigger: PendingManualTrigger | null;
  prune: PruneState;
  nudges: Nudges;
  stats: SessionStats;
  /** tool_use.id -> parameter entry */
  toolParameters: Map<string, ToolParameterEntry>;
  /** ordered list of tool_use.ids seen this session */
  toolIdList: string[];
  messageIds: MessageIdState;
  lastCompaction: number;
  currentTurn: number;
  modelContextLimit: number | undefined;
  /**
   * True when durable maps have diverged from the last `dcp-state` custom
   * entry. Flushed on compress, manual-mode change, session_before_switch,
   * session_shutdown, and post-compaction clear.
   */
  dirty: boolean;
  /** Transient (never persisted): the ref-tagged messages from the last context pass, for the compress tool to resolve ranges. */
  lastContextMessages: AgentMessage[] | null;
}
