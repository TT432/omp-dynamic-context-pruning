# DCP for omp — Design

Dynamic Context Pruning for Oh My Pi, modeled on
[Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).

## Core invariant

**Session history is never modified.** DCP only transforms the *copy* of the
conversation sent to the LLM on each provider request. Compressed ranges are
replaced with summaries; superseded / errored tool content is replaced with
placeholders. The persisted session stays byte-for-byte intact.

omp gives exactly the right hook for this: the `context` event returns
`{ messages }`, replacing the messages array for **a single LLM call only**.
This is the heart of the plugin and the direct analogue of DCP's
`experimental.chat.messages.transform`.

## API surface mapping (OpenCode plugin → omp extension)

| DCP (OpenCode)                        | omp extension                                              |
| ------------------------------------- | ---------------------------------------------------------- |
| `experimental.chat.messages.transform`| `pi.on("context", ...)` → `{ messages }`                   |
| `experimental.chat.system.transform`  | system-prompt append via injected custom message + tool description |
| `tool.compress`                       | `pi.registerTool({ name: "compress" })`                    |
| `command.execute.before`              | `pi.registerCommand(...)`                                  |
| `event`                               | `pi.on("session_start" / "tool_result" / ...)`             |
| `ctx.client.session.*` state          | `pi.appendEntry(...)` + `ctx.sessionManager.getBranch()`   |

## The compress tool does NOT call an LLM

Critical design point. In DCP the compress tool's schema requires the model to
provide the `summary` text itself:

```
content: [{ startId, endId, summary: "Complete technical summary..." }]
```

The model that has the context writes its own compression summary. The tool
only validates ranges, appends protected content, and stores a compression
block. No one-shot LLM call is needed from inside the extension — and omp does
not export `completeSimple` to extensions anyway. This removes the only
plausible blocker for the port.

## Message identity without stable message IDs

DCP keys everything on `message.info.id` (OpenCode assigns every message a
stable id). omp's `AgentMessage` has **no id field**; the id lives on the
session *entry*, not the message, and the `context` event delivers plain
`AgentMessage[]`.

Resolution: derive a stable identity from content.

- A message with ≥1 `tool_use` block → identity = `"tu:" + tool_use.id`
  (provider-assigned, globally unique, persisted, never mutated).
- A message with only text/other blocks → identity = a content signature of
  `role + text`, disambiguated by ordinal among same-signature messages.
- `tool_result` blocks are identified by their `tool_use_id` (pairs with the
  matching `tool_use`).

This identity is stable across context rebuilds because omp never mutates
`tool_use.id`, `tool_use.input`, user text, or assistant text — it only prunes
`tool_result` *content*, which is excluded from the signature.

Flow (content anchors — see "Why not tags" below):

1. Model calls `compress({ content: [{ startAnchor, endAnchor, summary }] })`,
   quoting short verbatim phrases from the first / last message of the range.
2. Compress tool substring-matches each anchor (whitespace- and
   case-normalized) to a message — rejecting it as ambiguous if it matches more
   than one — resolves the span, and stores a compression block keyed by the
   span's message identities + tool ids.
3. Future `context` passes recompute identities, elide messages belonging to an
   active compression block, and inject the summary at the earliest effective
   message.

## Why not per-message tags (an omp constraint)

Upstream DCP tags every message with `<dcp-message-id>m####</dcp-message-id>`
and strips hallucinated tags via a `text.complete` hook. **omp has no
output-mutation hook** — every `message_*` lifecycle event is notification-only
(verified in `pi-coding-agent/src/extensibility/extensions/types.ts`). So
tag injection is unsafe here: the model imitates the tag pattern into its own
output, which is then persisted and displayed with no way to strip it. Content
anchors inject nothing, so there is nothing to imitate. The `context` event
itself is LLM-only (verified in `pi-agent-core/src/agent-loop.ts`: transform
output flows to `llmMessages` and is never written back to storage/display).

## Modules

```
index.ts                 extension factory entry; wires hooks/tools/commands
src/
  omp.d.ts               ambient declarations for the omp API surface used
  config.ts              config model, defaults, validation, JSON-schema load
  logger.ts              debug logger writing under ~/.omp/agent/logs/dcp
  token-utils.ts         token estimation (chars/4 fallback)
  state/
    types.ts             SessionState, CompressionBlock, PruneMessagesState…
    state.ts             createSessionState factory
    persistence.ts       serialize/save/load via pi.appendEntry (custom entries)
    utils.ts             block allocation, summary wrapping, isMessageCompacted
  messages/
    shape.ts             omp AgentMessage content-block helpers (typed accessors)
    identity.ts          stable content-signature identity + m-ref assignment
    query.ts             user-message / tool-metadata extraction
    prune.ts             the context-hook core: placeholder + summary injection
    nudge.ts             compress nudge injection (context-limit / turn / iteration)
  strategies/
    deduplication.ts     drop older identical tool calls, keep most recent
    purge-errors.ts      drop errored tool inputs after N turns
  compress/
    range.ts             compress tool (range mode)
    range-utils.ts       range resolution, nesting, placeholder handling
    protected-content.ts append protected tool outputs / user msgs to summaries
    types.ts             shared compress types
  prompts/
    system.ts            system-prompt block describing the compress tool
    compress-range.ts    the compress tool description + format extension
    nudge.ts             nudge prompt bodies
  protected-patterns.ts  glob matching for protected tools / file paths
  hooks.ts               context/system/event/turn handlers
  commands.ts            /dcp, /dcp-compress, /dcp stats, /dcp context
```

## Session lifecycle (omp-accurate)

omp's extension events (from `shared-events.d.ts`) drive binding. DCP does **not**
trust event payloads for session id or model window — those live on `ctx`:

| Need | Source |
| ---- | ------ |
| Session id | `ctx.sessionManager.getSessionId()` (fallback: `getSessionFile()`) |
| Context window | `ctx.model.contextWindow` (fallback: `ctx.getContextUsage()?.limit`) |
| Durable state | latest `custom` entry with `customType: "dcp-state"` on `getBranch()` |

### Handlers

| Event | Action |
| ----- | ------ |
| `session_start` | `bindSession`: reset if id changed → load `dcp-state` → sync model window → one-shot system inject |
| `session_before_switch` | `flushSessionState` into the **current** session file (still bound) |
| `session_switch` | `bindSession` for the new session (reason: new/resume/fork/handoff) |
| `session_compact` | clear compression blocks (identities invalid) + persist cleared state |
| `session_shutdown` | flush if dirty |
| `context` | lazy-bind if unbound; sync model; reconcile compaction via branch timestamps; prune pipeline |
| `turn_end` | sync model window only |

### Dirty / persist

- `state.dirty` marks durable divergence from the last `dcp-state` entry.
- Set dirty on: successful compress, manual-mode toggle, compaction clear.
- Flushed on: compress, manual toggle, `session_before_switch`, `session_shutdown`, post-compact.
- `loadSessionState` never overwrites the live `sessionId` or a already-synced
  `modelContextLimit` (serialized values are advisory).

### Same-session re-bind

`bindSession` is a no-op when the resolved id equals `state.sessionId`, so a
redundant `session_start` after an in-flight compress cannot wipe blocks.


## Faithfulness vs. deferral

Implemented (production core):
- `context` transform (placeholdering + summary injection) — the heart
- compress tool, range mode (model-authored summaries, nested blocks incl.
  boundary-block fold-in when a range starts/ends on an existing block)
- strategies: deduplication, purge-errors
- system-prompt injection + context-limit / turn / iteration nudges
- protected tools + protected file patterns
- protected-content appended into compression summaries
- compress notifications via `ctx.ui.notify` (off/minimal/detailed)
- config system (`dcp.jsonc` with layered global/project discovery)
- state persistence across sessions via custom entries
- slash commands: `/dcp`, `/dcp-compress [focus]`, `/dcp stats`, `/dcp context`

Deferred / consciously omitted:
- compress `message` mode — experimental upstream; range mode is the
  production default. Tracked for follow-up.
- per-compress permission prompt — OpenCode's `ask` flow; declined (auto preferred).
- subagent-result extension in protected content — subagents are out of scope
  (`experimental.allowSubAgents` defaults false).
- manual-mode gating inside the compress tool — declined (manual mode unused).
- compress timing/duration tracking — cosmetic; declined.
- TUI panel — OpenCode's panel system is host-specific; omp commands cover the
  same surface.
- npm auto-update — the plugin is local/source-installed; updates are manual.
- `/dcp sweep`, `recompress`, `decompress` — secondary commands; the state model
  supports them and they can be added without redesign.
