# omp-dcp — anchor-based conversation compression

Dynamic Context Pruning for [Oh My Pi (omp)](https://omp.ai), distilled to one
mechanism: **model-driven compression of conversation spans from a named
anchor up to the compress call** — without ever modifying session history. All
transforms happen on the copy of the conversation bound for the LLM; the
persisted session stays byte-for-byte intact.

Because omp counts context from the provider's real prompt-token report, the
savings are real: the context bar drops and omp's auto-compaction is deferred.

## What it does

Three tools are exposed to the model:

- **`add_anchor({ anchor })`** — places a named anchor at the call site. The
  tool call itself is the anchor: its provider-assigned tool-call id is a
  stable, globally unique identity. Names are unique per session;
  `session_start` is reserved. Order is load-bearing: compress the finished
  unit first, then anchor the next one —
  *anchor A → work → compress(A) → anchor B → work → compress(B)*. An anchor
  placed **before** a compress call lies inside that span, is elided with it,
  and disappears from the anchor list; it cannot be reused.
- **`compress({ startAnchor, summary })`** — replaces everything from the start
  anchor up to the compress call itself with a **summary the model writes
  itself**. The end of the span is implicit: the compress call's own position.
  `summary` must be a plain Markdown string — the host silently stringifies an
  object-shaped summary, so a JSON draft is accepted but loses its shape.
- **`expand({ block })`** — returns the stored summary of a compression block
  that is currently shown only as an index line under a newer summary. It
  returns summaries, never the original messages.

A virtual **`session_start`** anchor is always injected right after the
original user prompt, so everything since the beginning of the session can be
compressed while the prompt itself stays intact.

### Compression semantics

```
prompt · work1 · add_anchor(a1) · work2 · work3 · compress(a1, summary)
```

becomes, in the LLM-facing context:

```
prompt · [anchor: session_start] · work1 · [Compressed: a1 → here] (block 1) summary · compress(a1, summary)
```

- Everything after the start anchor up to the compress call is replaced by the
  summary, which takes the span's place right before the compress call.
- **The start anchor is consumed; the compress call and its confirmation
  stay in context** — later turns can see that the compression happened.
- Earlier compressions whose compress call lies before the start anchor stay
  in place: their summaries and yours **accumulate in order**.
- A span that reaches back across a prior compression **absorbs** it: the
  absorbed block keeps its summary in dcp's chain, appears as a one-line index
  under the new summary, and comes back through `expand`. That guarantee covers
  the absorbed block only — not the current span: its messages leave the
  model's context, and a chain-root block has no ancestors to expand.
- Invalid *calls* still fail and change nothing: unknown anchor, empty span,
  empty summary, unknown block id. Invalid *summaries* do not — see below.
- Session history is never modified; compression only reshapes what is sent to
  the model. Blocks persist across session resume (omp custom entries) and are
  dropped automatically if omp compacts the session.

### Summary shape — prompt only, never checked

A summary is the only record of the span, so the tool description asks for a
structure:

```
## 当前任务        - 正在做的事 证据: <定位>
## 已完成          - 动作/结论 证据: <定位>
## 未完成          - 下一步具体动作 证据: <定位>
## 约束            - 用户要求/不变量 证据: <定位>
## 文件与命令      - 关键路径/命令 证据: <定位>
## 在跑作业与句柄  - 作业/子代理/端口 证据: <定位>
```

- Each slot once, in that order; a slot with nothing to report is a single
  `- 无`; `当前任务` should be the real task.
- Every fact is a `- ` bullet ending in `证据: <定位>` — an externalized pointer
  (path, `file:line`, session id, commit, URI, command), **not** pasted content.
  Any locator shape is accepted; there is no whitelist.
- Nothing is checked. There is no shape parser, no advisory in the result and no
  rejection: whatever the model writes is applied verbatim and cannot be amended
  afterwards. The contract lives in the tool description, where the model reads
  it before every call; a second copy in the result only taught the model the
  validator. (Removed 2026-11-04 — a session with 26+20 advisory lines acted on
  none of them.)
- `summary` is a plain Markdown string. The host silently stringifies an
  object-valued summary, so a JSON or key-value draft passes and loses the slot
  structure (and every `证据:` pointer).

## How it works

Every provider request fires omp's `context` event (confirmed LLM-only in
`pi-agent-core/src/agent-loop.ts` — the transform output goes to the provider
and is never written back to storage or the display transcript). On a clone of
the messages, DCP:

1. injects the `[anchor: session_start]` marker after the first user message,
2. elides the span from each live block's start anchor up to its compress call
   and strips the consumed-anchor blocks. An absorbed block's span is folded
   into the surviving one — the start is the earliest of the block's own anchor
   and every ancestor's — so absorbing can only widen the elided range, never
   narrow it (narrowing resurrects messages that were already gone),
3. injects each block's summary right before its compress call, followed by one
   index line per absorbed ancestor.

`compress` resolves the anchor name on the persisted branch (positions are
stable; even consumed anchors remain findable there), validates the span,
absorbs the blocks it reaches back over, and records the block. Anchor names are
read from the call payload in the shapes models actually emit: `anchor`, `name`,
`anchorName`, `content`, a bare token, or a payload that `JSON.parse` rejects
(raw newlines) — a name dcp cannot read is an anchor the model cannot use.

## Installation

This is a source extension (a directory with `package.json` declaring
`omp.extensions`). Add it to your omp config:

```yaml
# ~/.omp/agent/config.yml   (or <project>/.omp/config.yml)
extensions:
  - /path/to/omp-dcp
```

Restart omp. The model gets the `add_anchor`, `compress` and `expand` tools.

## Configuration

Set `DCP_DEBUG=1` in the environment to write per-pass context snapshots
and structured logs under `~/.omp/agent/logs/dcp/`.

`DCP_REMIND_THRESHOLD` controls the token-pressure reminder — the only thing
dcp pushes into the conversation. When the estimated (post-compression) context
crosses the threshold, a `[dcp:context]` message reports the estimate, the fill
percentage and the live anchor names, and says nothing about what to do: when
and how to compress is the model's call, and that rule lives in the `compress`
tool description. dcp is model-driven, and with omp auto-compaction disabled a
forgotten compress otherwise walks the context past the window and stalls the
session. Values: `(0,1)` = fraction of the model's context window (default
`0.4`), `>=1` = absolute tokens, `0` = disabled.

There is no work-unit trigger. The previous `[dcp:unit]` fired whenever the
newest `todo` result reported a finished item set, but the todo list is
bookkeeping the model fills in under pressure from the host's stop-reminder, not
a semantic event: measured 2026-11-04, 13 items were marked done in one second,
the reminder fired 20 s later, a 1494-message span was compressed, and the
user's next instruction arrived 16 s after that into a context that no longer
held the work it referred to.

There is no tool-call counter either: a call count is not a context cost, and the
removed `[dcp:budget]` trigger fired three minutes into a session that then had
to re-read the files it had just explored.

At most one reminder is appended per request, and it recomputes on the
transformed copy, so a compression silences it. The reminder only ever touches
the outgoing message copy; session history is never modified.

## Verification

- `bunx tsc --noEmit` — type-checks clean. Without bun, `node node_modules/typescript/bin/tsc --noEmit`
  also works (Node 24 is enough).
- `bun smoke-test.ts` — exercises the full pipeline (anchor scanning including
  the payload shapes that broke it, all three tools, transform, accumulation,
  span widening on absorption, chain recall/expand, session_start, anchor-name
  resolution, persistence round trip + v5/v4 migration, session lifecycle,
  orphan cleanup) against synthetic omp messages, plus the token reminder.
  On a bun-less Windows host, with the resolver hook in `work/`:
  `node --experimental-strip-types --experimental-loader ./work/ts-resolve.mjs smoke-test.ts`.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
