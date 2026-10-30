# DCP for omp — Design (anchor mode)

Dynamic Context Pruning for Oh My Pi, distilled to a single mechanism:
**model-driven compression of the conversation span from a named anchor up to
the compress call itself**.
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

`compress({ startAnchor, summary, force? })` resolves the anchor on the
persisted branch (`ctx.sessionManager.getBranch()`), validates, and records a
compression block. **The end of the span is implicit: the compress call
itself.** There is no `endAnchor` — a span always runs from the start anchor
to the point where the model calls compress. When execute runs, the in-flight
compress call is usually not yet appended to the branch; it lands at the end,
so the end position falls back to `messages.length` (validation and elision
counting only — the durable identity is the compress call's tool-call id).

Two gates run before any branch scanning, so a rejected call mutates nothing
(INV-4):

1. `startAnchor === "session_start"` requires `force: true`;
2. `validateSummary(summary, { full: startAnchor === "session_start" })` —
   the fixed-slot schema below; `full` selects the strict tier.

```ts
{
  id, startName, startToolCallId /* null = session_start */,
  summary, compressCallId /* implicit span end */, createdAt
}
```

The context transform then applies every active block:

- whole-elide messages in `(startMsgIdx, compressMsgIdx)` — for
  `session_start` starts, `[firstUser+1, compressMsgIdx)`;
- strip the start anchor's `add_anchor` toolCall block and its toolResult
  message (**start anchor consumed**); if stripping leaves the message with
  no tool calls at all, the whole message is dropped — a surviving text-only
  shell reads as an assistant turn that announces tool calls and then stops,
  which the model imitates (observed live: 20+ text-only stall turns after
  every compress, session 019fef18, 2026-08-13);
- keep the compress call itself and its toolResult in context — the call is
  the span's end, and the success confirmation is the visible record that the
  compression happened;
- inject `[Compressed: start → here]\n<summary>` as a synthetic user message
  right **before** the compress call's message — the summary takes the elided
  span's place and the compress call follows it.

### Provider-validity guards

Two post-strip invariants keep the provider from rejecting the request
(learned from a live HTTP 400: "assistant must not be empty") and the model
from stalling:

- **No call-less shells** — a message left without tool calls by stripping is
  dropped outright, whether it is thinking-only (providers reject
  content-less assistant messages) or text-only (an "I'm about to call
  tools：" turn that just ends teaches the model to stall the same way).
- **No orphan calls** — a kept toolCall whose toolResult message was elided is
  stripped as well (call/result pairing). Typical case: the start anchor's
  message also carried other tool calls whose results fall inside the span.

### Accumulation, absorption, and overlap rules

The new span always ends at the new compress call `N` (eliding
`[N_lo, N_idx)`). An existing block B elides `[B_lo, B_hi)` where `B_hi` is
the message index of B's own compress call — always before `N`:

| Situation | Rule |
| --- | --- |
| `B_hi < N_lo` | keep B — B ends before the new span starts; its summary and compress pair stay in place, summaries **accumulate** in order |
| `B_hi ≥ N_lo` and `B_lo ≥ N_lo` | consume B — fully contained (B's compress call, summary injection point, and span all fall inside the new span), absorbed into the new summary |
| `B_hi ≥ N_lo` and `B_lo < N_lo` | reject — the start anchor lies inside B's active span; absorbing half of B would leave a dead block whose injection point is elided |

Invariants these rules preserve:

- **INV-1** distinct surviving blocks have distinct compress calls (one call
  per block by construction).
- **INV-2** a surviving block's compress call and summary injection point are
  never elided by another surviving block.
- **INV-4** a failed compress (thrown validation) mutates no state.

Tool_use/tool_result pairs are always stripped together (no orphan blocks);
messages left empty are dropped.

## Summary schema (`src/summary.ts`)

A free-form summary fails in two ways that a later turn cannot detect: it
drops what the model forgot to write (session 01a18b4e, 2026-10-30: 22
full-session compressions, several of them silently dropping the live user
instruction), and its prose cannot be distinguished from invention. The
schema makes both checkable at the tool boundary:

| Slot (fixed order) | Purpose |
| --- | --- |
| `当前任务` | what is actually being worked on — mandatory, never `无` |
| `已完成` | actions/conclusions reached in the span |
| `未完成` | the next concrete action |
| `约束` | user requirements, invariants, prohibitions |
| `文件与命令` | key paths, entry points, reproducible commands |
| `在跑作业与句柄` | background jobs, subagent ids, service ports |

Structure rules (all tiers): each slot exactly once and in order; every line
inside a slot is `- <fact> 证据: <locator>`; an empty slot is `- 无`; no
free-form preamble before `## 当前任务`; facts ≤ 600 chars so the summary
carries pointers instead of pasted content; `证据` must not be `无`.

Evidence is the externalization mechanism: a fact names where it lives
(path, `file:line`, session id, tool name, command) so the next turn can
re-read the source instead of trusting the paraphrase.

Strict tier (`full: true`, i.e. `session_start` + `force`): `已完成` and
`未完成` must carry real content, and every evidence pointer must contain a
locator (`:`, `#`, `/`, `\`, `@`). This is the deliberate "cost" of
full-session compression — it discards the most and therefore must prove the
most. Tier 1 stays cheap (a vague pointer is tolerated) so ordinary
compressions do not lose their main benefit.

## Modules

```
index.ts        extension factory: registers context handler, lifecycle, tools
src/
  omp.d.ts      ambient declarations for the omp API surface used
  anchors.ts    anchor model: scanAnchors, session_start, toolCall/toolResult lookup
  state.ts      SessionState, CompressionBlock, dcp-state (v3) persistence
  tools.ts      add_anchor + compress tool factories
  summary.ts    summary schema: fixed slots, evidence pointers, strict tier
  transform.ts  the context-transform heart: elide / strip / inject
  remind.ts     compress reminders: token budget, todo-set completion, tool-call budget
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
| `context` | lazy-bind if unbound; reconcile omp-side compaction by branch timestamps; clone → transform → append at most one reminder → return |

Same-session re-bind is a no-op, so in-flight compress state is never wiped.

## Compress reminders

dcp is model-driven: nothing forces a compress, and omp auto-compaction is
commonly disabled in favor of dcp. A model that forgets walks the context past
the window and the session stalls (observed 2026-10-01: 264k on a 256k
window, turns dying with `stopReason: "length"`). Three triggers, all computed
on the already-transformed copy and all appended as a synthetic user message
that is never persisted:

| Marker | Fires when | Configuration |
| ------ | ---------- | ------------- |
| `[dcp:context]` | estimated post-transform context crosses the token budget | `DCP_REMIND_THRESHOLD`: (0,1) = fraction of the model window (default 0.4); >=1 = absolute tokens; <=0 = off |
| `[dcp:unit]` | the newest `todo` result reports a finished item set (`All items complete` / `Remaining items (0)`) | none — the boundary is observable, not judged |
| `[dcp:budget]` | N tool calls have run since the last compress | `DCP_REMIND_TOOLCALLS` (default 40, <=0 = off) |

At most one reminder is appended per request; priority is
`[dcp:context]` > `[dcp:unit]` > `[dcp:budget]`. Because the counters are
computed after the transform, a compress resets them and the reminders stop.

Estimate: newest assistant usage report anchors the total, tail counted at
~4 chars/token (see `estimateContextTokens`). Known limitation: right after a
compress the newest usage report can still be the stale pre-compression one,
so the token reminder may fire once more before the next turn corrects it.

## Persistence

Only compression blocks are durable — anchors re-derive from history by
scanning. State rides omp custom entries (`customType: "dcp-state"`, `v: 4`);
the latest entry on the active branch wins. v1–v3 entries (range-mode and
end-anchor eras) are ignored. Blocks whose anchors or compress call no longer
resolve at transform time (fork/compaction residue) are dropped lazily and
the state marked dirty so the next flush persists the cleanup.

## Errors surface to the model

Both tools fail by throwing — the model sees the error tool_result and no
state changes. Unknown-anchor errors list the available anchors so the model
can recover immediately. Schema errors name the offending line and restate the
required shape (slot list, `- ` bullet form, `证据: <定位>` suffix), so a
rejected compression comes back as a concrete rewrite instruction rather than
a generic refusal.

## Deliberately removed (vs. the range-mode port)

- deduplication / purge-errors strategies and all nudges — compression is
  explicit now;
- slash commands, prune notifications, protected tools/file patterns,
  protected-content append, system-prompt injection;
- the layered `dcp.jsonc` config system (no configuration remains; debug is
  `DCP_DEBUG`);
- content-signature message identity and verbatim-phrase anchor resolution —
  named anchors make both unnecessary.
