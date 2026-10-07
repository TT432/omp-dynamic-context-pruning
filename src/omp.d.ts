/**
 * Ambient declarations for the Oh My Pi (omp) extension API surface that this
 * plugin depends on. Sourced from the omp internal docs
 * (omp://extensions.md, omp://hooks.md, omp://session.md, omp://sdk.md).
 *
 * These exist so the plugin type-checks standalone; at runtime omp resolves
 * `@oh-my-pi/pi-coding-agent` to its host-bundled copy and the `ExtensionAPI`
 * is injected into the factory.
 *
 * Only the surfaces actually used by this plugin are declared.
 */

// ---------------------------------------------------------------------------
// Messages (pi-mono shape — packages/ai/src/types.ts)
//
// The `context` event fires before convertToLlm, so messages use the internal
// representation: assistant messages carry `toolCall` blocks with `arguments`,
// and tool results are standalone `toolResult` messages keyed by `toolCallId`.
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** Provider-assigned, globally unique, persisted tool-call id. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
  text?: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ThinkingBlock | Record<string, unknown>;

export interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "toolResult" | "custom" | string;
  content: string | ContentBlock[];
  /** toolResult messages: id of the originating tool call. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  provider?: string;
  model?: string;
  usage?: MessageUsage;
  timestamp?: number;
  customType?: string;
  // omp allows arbitrary passthrough fields; keep an index for safe access.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session entries (ctx.sessionManager.getBranch())
// ---------------------------------------------------------------------------

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | ContentBlock[];
  display?: boolean;
  attribution?: "user" | "agent";
}

export type SessionEntry = SessionEntryBase | MessageEntry | CustomEntry | CustomMessageEntry;

export interface SessionManager {
  getBranch(): SessionEntry[];
  getSessionFile(): string | undefined;
  /** Stable session id (preferred over getSessionFile for binding). */
  getSessionId?(): string;
}

// ---------------------------------------------------------------------------
// Extension contexts
// ---------------------------------------------------------------------------

export interface ExtensionUIContext {
  notify(message: string, level?: "info" | "warn" | "error"): void;
  setStatus?(key: string, text: string): void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  hasUI: boolean;
  cwd: string;
  sessionManager: SessionManager;
  /** Live session model; contextWindow is the authoritative window size. */
  model?: { id?: string; contextWindow?: number; [k: string]: unknown };
  /** Optional usage snapshot; contextWindow (omp ≥18) or limit is a fallback window when model is unset. */
  getContextUsage?(): { tokens?: number; contextWindow?: number; limit?: number } | undefined;
  isIdle(): boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

export interface ToolExecuteContext {
  signal?: AbortSignal;
  onUpdate?(chunk: { content: unknown[] }): void;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  hidden?: boolean;
  defaultInactive?: boolean;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ToolExecuteContext["onUpdate"],
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
  onSession?(event: { reason: string }, ctx: ExtensionContext): void;
}

export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface ContextEvent {
  type?: "context";
  /** Messages about to be sent to the LLM (deep copy, safe to modify). */
  messages: AgentMessage[];
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** Fired on initial session load. Payload is type-only; bind via ctx.sessionManager. */
export interface SessionStartEvent {
  type?: "session_start";
}

/** Fired before switching sessions (still bound to the old session file). */
export interface SessionBeforeSwitchEvent {
  type?: "session_before_switch";
  reason: "new" | "resume" | "fork" | "handoff";
  targetSessionFile?: string;
}

/** Fired after switching to another session. */
export interface SessionSwitchEvent {
  type?: "session_switch";
  reason: "new" | "resume" | "fork" | "handoff";
  previousSessionFile: string | undefined;
}

/** Fired after context compaction lands a CompactionEntry. */
export interface SessionCompactEvent {
  type?: "session_compact";
  compactionEntry: { timestamp?: string; [k: string]: unknown };
  fromExtension: boolean;
}

/** Fired on process exit (SIGINT/SIGTERM). */
export interface SessionShutdownEvent {
  type?: "session_shutdown";
}

/** Fired at the end of each agent turn. */
export interface TurnEndEvent {
  type?: "turn_end";
  turnIndex?: number;
  message?: AgentMessage;
  toolResults?: unknown[];
}

// ---------------------------------------------------------------------------
// Zod-like schema (omp injects a zod-like object with no top-level `optional`;
// use the schema instance method `.optional()` instead — verified 2026-10-07).
// ---------------------------------------------------------------------------

export interface ZodSchema<T = unknown> {
  _def: unknown;
  _type?: T;
  optional: () => ZodSchema<T | undefined>;
}

export interface ZodNamespace {
  string: (opts?: { description?: string }) => ZodSchema<string>;
  number: (opts?: { description?: string; min?: number }) => ZodSchema<number>;
  boolean: (opts?: { description?: string }) => ZodSchema<boolean>;
  array: <T>(schema: ZodSchema<T>) => ZodSchema<T[]>;
  object: <T extends Record<string, ZodSchema>>(shape: T) => ZodSchema<object>;
  enum: <T extends string>(values: readonly T[], opts?: { description?: string }) => ZodSchema<T>;
}

// ---------------------------------------------------------------------------
// Extension API (injected into the default-exported factory)
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  zod: ZodNamespace;
  logger?: { debug?(...a: unknown[]): void; info?(...a: unknown[]): void; warn?(...a: unknown[]): void };

  setLabel(label: string): void;

  on(event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: AgentMessage[] } | void> | { messages?: AgentMessage[] } | void): void;
  on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_before_switch", handler: (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_switch", handler: (event: SessionSwitchEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_compact", handler: (event: SessionCompactEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<Partial<ToolResult> | void> | Partial<ToolResult> | void): void;
  on(event: "turn_end", handler: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: "message_end", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;

  registerTool(definition: ToolDefinition): void;

  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    },
  ): void;

  /** Persist a non-LLM custom entry on the session (rebuilt from getBranch() on session_start). */
  appendEntry(customType: string, data: unknown): Promise<void> | void;

  /** Inject a custom message into the live conversation. */
  sendCustomMessage?(message: { customType: string; content: string | ContentBlock[]; display?: boolean; attribution?: "user" | "agent" }, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }): Promise<void> | void;

  /** Package exports (full omp surface). */
  pi: Record<string, unknown>;
}
