# DCP for omp — Design (anchor mode, chained summaries)

Dynamic Context Pruning for Oh My Pi, distilled to a single mechanism:
**model-driven compression of the conversation span from a named anchor up to
the compress call itself**, with absorbed spans preserved as a **chain** rather
than merged away.

Originally modeled on
[Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning);
the automatic strategies, nudges, commands, and config system were removed in
favor of explicit, model-placed anchors.

## Core invariants

- **Session history is never modified.** DCP only transforms the *copy* of the
  conversation sent to the LLM on each provider request (omp's `context`
  event; verified LLM-only in `pi-agent-core/src/agent-loop.ts`). The
  persisted session stays byte-for-byte intact.
- **No block text is ever destroyed.** A compression that absorbs an older
  block records it in the chain; the older block's summary stays in state and
  comes back through `expand`. (INV-1)
- **No content judgement.** A summary is applied verbatim: no shape parse, no
  advisory, no rejection. The contract lives in the tool description, and dcp
  never decides what a summary may contain. (INV-2)
- **A failed call mutates nothing** — errors are reserved for calls that cannot
  mean anything (unknown anchor, empty span, empty summary, unknown block id).
  (INV-3)

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

Anchor lifecycle is the model's job, and the tool descriptions state the order:
*anchor A → work → compress(A) → anchor B → work → compress(B)*. An anchor
placed **before** a compress call sits inside that span: the transform elides it
and the reminder (computed on the transformed copy) no longer lists it. The
pre-chain design let that happen silently, and the model then always fell back to
`session_start` (live evidence: one anchor in 350 tool calls, absorbed 71 s after
it was created, three full-session compressions in 68 minutes). The compress
result therefore names every anchor the span swallowed.

Name extraction is deliberately tolerant, because an unreadable name is an
anchor the model cannot use. Over 948 persisted payloads (2026-11-04), the shapes
models emit were `{"anchor"}` (245), `{"name"}` (659), `{"name","note"}` /
`{"name","title"}` / `{"name","i"}` (34), `{"anchorName","description"}` (4), and
a bare token in `content` (`wu_finalize`). The old rule — `anchor`, else the
lone string value — lost 3.9% of anchors silently, and every one of them became
"unknown startAnchor" at the next compress. `anchorNameOf` now reads
`anchor` → `name` → `anchorName` → `content`, ignores metadata keys
(`i`/`intent`/`title`/`note`/`summary`/`description`/`reason`/`path`/`force`/…),
falls back to exactly one non-metadata string, accepts a bare token, and
recovers the name textually when `JSON.parse` fails (raw newlines inside a
summary). A compress-shaped payload arriving at `add_anchor` still yields
nothing — no phantom anchors.

## Message representation (verified against live transcripts)

The `context` event fires before `convertToLlm` (pi-mono `agent-loop.ts`), so
messages use the internal pi-mono shape, **not** the Anthropic wire shape:

- assistant messages carry `{type:"toolCall", id, name, arguments}` blocks;
- tool results are standalone `{role:"toolResult", toolCallId, toolName,
  content, isError}` messages — not `tool_result` blocks inside a user message;
- user message content may be a plain string or a block array.

Extension tools surface in the transcript through the harness's xd:// device
layer: the model invokes them via the built-in `write` tool, so an anchor call
persists as `write({path:"xd://add_anchor", content:"<json args>"})` and a
compress call as `write({path:"xd://compress", ...})`. Anchor scanning
recognizes both the direct `add_anchor(...)` form and the xd envelope (anchor
name from the `anchor` arg, falling back to a lone string value — models
sometimes guess `name`). Stripping is id-based and therefore shape-agnostic.

## compress semantics

`compress({ startAnchor, summary })` resolves the anchor on the persisted
branch (`ctx.sessionManager.getBranch()`), validates the span, records a block.
**The end of the span is implicit: the compress call itself.** There is no
`endAnchor`. When execute runs, the in-flight compress call is usually not yet
appended to the branch; it lands at the end, so the end position falls back to
`messages.length` (validation and elision counting only — the durable identity
is the compress call's tool-call id).

```ts
{
  id, startName, startToolCallId /* null = session_start */,
  summary, compressCallId /* implicit span end */,
  parentIds,   // blocks this one absorbed, newest first
  supersededBy, // id of the block that absorbed this one, null while live
  createdAt
}
```

Preconditions that still throw: non-empty `startAnchor`, non-empty `summary`,
an anchor that exists, and a span with at least one message in it.

### Chain, not merge

Every live block whose compress call falls inside the new span is absorbed:
`parentIds` gains its id and it is marked `supersededBy = newId`. Its summary
text is **kept**, and `expand({block})` returns it verbatim (plus its own index
lines, so the walk can continue).

Why the chain replaces content validation: an earlier design required the new
summary to re-state every locator recorded by the block it absorbed, and
rejected the compression otherwise. Measured cost in session 01a19fdd: 3 of 20
compressions rejected for missing locators — after the model had already spent
turns rewriting identifiers to match a string comparison. The chain makes the
requirement moot: the old text is still there, so "merge, don't rewrite" is no
longer a rule the model can fail.

**Absorption widens the span.** An absorbed block stops eliding, so the
surviving block must cover everything it covered: the render-time start is the
minimum of the block's own anchor start and every ancestor's start. It is
computed at transform time from the chain (`parentIds`), not stored, so the
persisted shape stays unchanged. Without it, compressing from an anchor that
sits inside an older span leaves `[olderStart, ownStart)` uncovered and those
messages come back — measured before the fix: 29 of 236 top-level sessions,
69,699 messages resurrected, worst single event 3,051 messages.

### Rendering

The context transform applies every live block:

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
- inject `[Compressed: start → here] (block N)\n<summary>` as a synthetic user
  message right before the compress call's message, followed by one index line
  per ancestor:

  ```
  已并入本块的旧压缩块（索引；仅摘要可 expand，原始消息不可恢复）:
  - 块 12「a1」：<当前任务 gist> — 摘要: expand({block: 12})
  ```

Ancestors are one line each, so the chain costs O(history) in lines rather than
bytes. Superseded blocks are text-only: they never elide anything, and they are
never dropped — `expand` must still be able to return them.

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

Blocks whose anchors or compress call no longer resolve (fork/compaction
residue) are dropped and the state marked dirty so the next flush persists the
cleanup.

## Summary shape — prompt only, nothing is checked

A free-form summary is a lossy paraphrase, so the tool description asks for a
fixed slot structure:

| Slot (recommended order) | Purpose |
| --- | --- |
| `当前任务` | what is actually being worked on |
| `已完成` | actions/conclusions reached in the span |
| `未完成` | the next concrete action |
| `约束` | user requirements, invariants, prohibitions |
| `文件与命令` | key paths, entry points, reproducible commands |
| `在跑作业与句柄` | background jobs, subagent ids, service ports |

Each fact is a `- ` bullet ending in `证据: <定位>` — a pointer (path,
`file:line`, session id, commit, URI, command) the next turn can re-read instead
of trusting a paraphrase.

There is no parser, no advisory, no rejection (removed 2026-11-04). `src/summary.ts`
is gone; the only summary-derived rendering left is a first-content-line gist for
ancestor index lines. Reasons:

- an advisory that arrives *after* the elision cannot change what was written —
  a live session produced 26 and then 20 `摘要形状提示` lines and every one was
  ignored, because the compression had already been applied and the tool
  description itself said the summary "cannot be amended afterwards";
- the earlier shape gates measured shape, not value: 17 of 20 compressions in
  session 01a19fdd were rejected by rules that still let a wrong fact through
  (`spawn_chance = 1.0` against a real `0.2`), and the model learned the
  validator instead of the lesson — live thinking: "gradle.properties has no
  slash. Use E:/…/gradle.properties? That contains slashes.";
- every mechanical check is one more place where dcp, not the model, decides what
  a summary may contain. The contract belongs in the tool description, which the
  model reads before each call.

The summary is a plain Markdown string. An object-valued `summary` is
stringified by the host before the tool sees it, so a JSON draft passes and
silently loses the slot structure; the tool description states this.

## Compress reminders

dcp is model-driven: when to compress is the model's call, and omp
auto-compaction is commonly disabled in favor of dcp. Exactly one trigger
remains, computed on the already-transformed copy and appended as a synthetic
user message wrapped in `<system-reminder source="dcp">` (never persisted, never
mistaken for user input):

| Marker | Fires when | Configuration |
| ------ | ---------- | ------------- |
| `[dcp:context]` | estimated post-transform context crosses the token budget | `DCP_REMIND_THRESHOLD`: (0,1) = fraction of the model window (default 0.4); >=1 = absolute tokens; <=0 = off |

The message is a **fact, not an instruction**: the estimate, the fill percentage
and the live anchor names, followed by a pointer to the `compress` tool
description, which carries the decision rule and the cost model. It exists
because the host exposes the token count to extensions and not to the model —
nothing else would stop a context from running into the window (2026-10-01:
264k tokens on a 256k window, turns dying with `stopReason: "length"`).

`[dcp:context]` brackets its reports (one per further 10% of the window,
persisted as `remindLevel`) so a context that sits above the threshold does not
re-nag every request.

**Removed: `[dcp:unit]` (todo set completed).** It treated the todo list as a
work-unit boundary. That list is bookkeeping the model fills in under pressure
from the host's stop-reminder, so the trigger measured the model's bookkeeping,
not the work: on 2026-11-04 thirteen items were marked done in one second, the
unit reminder fired 20 s later, the compress elided 1494 messages, and the
user's next instruction arrived 16 s after that into a context that no longer
held the work it referred to. Nothing replaced it: boundaries are the model's
judgement, stated in the tool description.

**There is no tool-call counter.** The removed `[dcp:budget]` fired at 40 calls
regardless of context size; in session 01a19fdd that meant a compression three
minutes in, on a context nowhere near the window, after which the model re-read
three files it had just read. A call count is not a cost: one 40 KB read and one
`todo` counted the same.

Estimate: `newest assistant usage report + local tail`, where the tail is
counted per character with CJK weighted separately (~2 chars/token) from ASCII
(~4 chars/token) — a single 4 chars/token constant under-counted Chinese-heavy
sessions by ~40% (measured 2.5 chars/token on the first uncompressed sample of
01a19fdd). Known limitation: right after a compress the newest usage report can
still be the stale pre-compression one, so `usageMark` suppresses it for one
request.

## Persistence

Compression blocks (including the chain) are durable; anchors re-derive from
history by scanning. State rides omp custom entries (`customType: "dcp-state"`,
`v: 6` — v6 dropped the `unitRemindId` watermark); the latest entry on the active
branch wins. v5 entries load as-is (chain fields are v5+), v4 entries are
migrated as chain roots; v1–v3 are ignored. Blocks whose anchors or compress call
no longer resolve at transform time (fork/compaction residue) are dropped lazily
and the state marked dirty so the next flush persists the cleanup.

## Errors surface to the model

Content problems never surface at all: a summary is applied as written, with no
advisory. Hard errors (unknown anchor / block, empty span, empty summary) list
the available anchors or block ids so the model can recover in the same turn.

## Deliberately removed

- the summary shape parser and its `摘要形状提示` advisory (2026-11-04): a message
  delivered after the elision cannot change the summary, and in a live session
  both rounds of warnings (26 and 20 lines) were ignored;
- the `[dcp:unit]` trigger and its `unitRemindId` watermark (2026-11-04): the
  todo list is bookkeeping the model writes under harness pressure, not a
  work-unit boundary;
- deduplication / purge-errors strategies and all nudges — compression is
  explicit now;
- slash commands, prune notifications, protected tools/file patterns,
  protected-content append, system-prompt injection;
- the layered `dcp.jsonc` config system (debug is `DCP_DEBUG`);
- content-signature message identity and verbatim-phrase anchor resolution —
  named anchors make both unnecessary;
- the summary **gates**: locator whitelist, fact/evidence length caps, strict
  tier for `session_start`, `force=true`, and locator inheritance. They were
  added as patches to three separate incidents (commits `2e18809`, `54a9ade`,
  `3caea33`) and collectively rejected 17 of 20 real compressions, while still
  letting a wrong fact through;
- the tool-call budget reminder and its durable watermark.
