# DCP for omp — Design (anchor mode)

Dynamic Context Pruning for Oh My Pi, distilled to a single mechanism:
**model-driven compression of conversation spans delimited by named anchors**.
Originally modeled on
[Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning);
the automatic strategies, nudges, commands, and config system were removed in
favor of explicit, model-placed anchors.

## Core invariant

**Session history is never modified.** DCP only transforms the *copy* of the
conversation sent to the LLM on each provider request (omp's `context` event;
verified LLM-only in `pi-agent-core/src/agent-loop.ts`). Compressed spans are
replaced with summaries; the persisted session stays byte-for-byte intact.

## Anchors

An anchor is a named position in the conversation:

- A **real anchor** is an `add_anchor` tool call. Its identity is the
  provider-assigned `toolCall.id` — globally unique, persisted, never mutated.
  No content signatures, no substring matching: resolution is an exact scan of
  the message array. Names are unique per session (the tool rejects duplicates,
  excluding its own in-flight call) and `session_start` is reserved.
- **`session_start`** is a virtual anchor the transform injects right after the
  first user message (role `user` without `tool_result` blocks — the original
  prompt). It is never consumed and is always available as a `startAnchor`.

## Message representation (verified against live transcripts)

The `context` event fires before `convertToLlm` (pi-mono `agent-loop.ts`), so
messages use the internal pi-mono shape, **not** the Anthropic wire shape:

- assistant messages carry `{type:"toolCall", id, name, arguments}` blocks;
- tool results are standalone `{role:"toolResult", toolCallId, toolName,
  content, isError}` messages — not `tool_result` blocks inside a user message;
- user message content may be a plain string.

Extension tools surface in the transcript through the harness's xd:// device
layer: the model invokes them via the built-in `write` tool, so an anchor call
persists as `write({path:"xd://add_anchor", content:"<json args>"})` and a
compress call as `write({path:"xd://compress", ...})`. Anchor scanning
recognizes both the direct `add_anchor(...)` form and the xd envelope (anchor
name from the `anchor` arg, falling back to a lone string value — models
sometimes guess `name`). Stripping is id-based and therefore shape-agnostic.

(The pre-rewrite `omp.d.ts` declared Anthropic-style `tool_use`/`tool_result`
blocks; that shape never occurs, and code written against it silently no-ops —
which is exactly how the first anchor-mode build failed in production.)

## compress semantics

`compress({ startAnchor, endAnchor, summary })` resolves both anchors on the
persisted branch (`ctx.sessionManager.getBranch()`), validates, and records a
compression block:

```ts
{
  id, startName, startToolCallId /* null = session_start */,
  endName, endToolCallId, summary, compressCallId, createdAt
}
```

The context transform then applies every active block:

- whole-elide messages in `(startMsgIdx, endMsgIdx)` — for `session_start`
  starts, `[firstUser+1, endMsgIdx)`;
- strip the start anchor's `add_anchor` toolCall block and its toolResult
  message (**start anchor consumed**; non-anchor content of the same message is
  kept, empty messages are dropped);
- keep the end anchor untouched (**end anchor survives** for chaining);
- keep the compress call itself and its toolResult in context — the success
  confirmation is the visible record that the compression happened;
- inject `[Compressed: start → end]\n<summary>` as a synthetic user message
  right **before** the end anchor's message — the summary takes the elided
  span's place and the end anchor follows it.

### Provider-validity guards

Two post-strip invariants keep the provider from rejecting the request
(learned from a live HTTP 400: "assistant must not be empty"):

- **No empty shells** — a message reduced to thinking blocks by stripping is
  dropped outright; providers reject content-less assistant messages.
- **No orphan calls** — a kept toolCall whose toolResult message was elided is
  stripped as well (call/result pairing). Typical case: the start anchor's
  message also carried other tool calls whose results fall inside the span.

### Chaining, absorption, and overlap rules

Given an existing block B `(bStartIdx, bEndIdx)` and a new range
`[start, end)`:

| Situation | Rule |
| --- | --- |
| `bEnd == end` | reject — the anchor already ends an active compression; chain from it instead |
| `end ∈ [bStart, bEnd)` | reject — the end anchor lies inside an active compression and cannot be guaranteed to survive |
| `bEnd == start` | keep B — **chaining**: B's summary sits before the new start anchor's message, outside the new span; summaries accumulate in order |
| `bEnd ∈ (start, end)` and `bStart ≥ start` | consume B — fully contained, absorbed into the new summary |
| `bEnd ∈ (start, end)` and `bStart < start` | reject — partial overlap |
| otherwise | keep B |

Invariants these rules preserve:

- **INV-1** distinct surviving blocks have distinct end anchors.
- **INV-2** a surviving block's end anchor and summary injection point are
  never elided by another surviving block.
- **INV-4** a failed compress (thrown validation) mutates no state.

Tool_use/tool_result pairs are always stripped together (no orphan blocks);
messages left empty are dropped.

## Modules

```
index.ts        extension factory: registers context handler, lifecycle, tools
src/
  omp.d.ts      ambient declarations for the omp API surface used
  anchors.ts    anchor model: scanAnchors, session_start, toolCall/toolResult lookup
  state.ts      SessionState, CompressionBlock, dcp-state (v3) persistence
  tools.ts      add_anchor + compress tool factories
  transform.ts  the context-transform heart: elide / strip / inject
  hooks.ts      session lifecycle: bind, flush, compact, context handler
  prompts.ts    tool descriptions, marker + summary formats
  logger.ts     debug logger (~/.omp/agent/logs/dcp, DCP_DEBUG=1)
smoke-test.ts   bun smoke test over synthetic omp messages
```

## Session lifecycle

| Event | Action |
| ----- | ------ |
| `session_start` / `session_switch` | bind: reset if the session id changed, load latest `dcp-state` entry, track latest compaction timestamp |
| `session_before_switch` / `session_shutdown` | flush dirty state into the current session |
| `session_compact` | clear all blocks (anchors may be compacted away) + persist the cleared state |
| `context` | lazy-bind if unbound; reconcile omp-side compaction by branch timestamps; clone → transform → return |

Same-session re-bind is a no-op, so in-flight compress state is never wiped.

## Persistence

Only compression blocks are durable — anchors re-derive from history by
scanning. State rides omp custom entries (`customType: "dcp-state"`, `v: 2`);
the latest entry on the active branch wins. v1 entries (range-mode era) are
ignored. Blocks whose anchors no longer resolve at transform time
(fork/compaction residue) are dropped lazily and the state marked dirty so the
next flush persists the cleanup.

## Errors surface to the model

Both tools fail by throwing — the model sees the error tool_result and no
state changes. Unknown-anchor errors list the available anchors so the model
can recover immediately.

## Deliberately removed (vs. the range-mode port)

- deduplication / purge-errors strategies and all nudges — compression is
  explicit now;
- slash commands, prune notifications, protected tools/file patterns,
  protected-content append, system-prompt injection;
- the layered `dcp.jsonc` config system (no configuration remains; debug is
  `DCP_DEBUG`);
- content-signature message identity and verbatim-phrase anchor resolution —
  named anchors make both unnecessary.
