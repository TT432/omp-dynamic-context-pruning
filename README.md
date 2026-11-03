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
  `session_start` is reserved. The anchor marks where the **next** span starts:
  *anchor A → work → anchor B → compress(A) → work → compress(B)*.
- **`compress({ startAnchor, summary })`** — replaces everything from the start
  anchor up to the compress call itself with a **summary the model writes
  itself**. The end of the span is implicit: the compress call's own position.
- **`expand({ block })`** — returns the full text of a compression block that is
  currently shown only as an index line under a newer summary.

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
  absorbed block keeps its text in dcp's chain, appears as a one-line index
  under the new summary, and comes back in full through `expand`. Nothing the
  model leaves out is destroyed.
- Invalid *calls* still fail and change nothing: unknown anchor, empty span,
  empty summary, unknown block id. Invalid *summaries* do not — see below.
- Session history is never modified; compression only reshapes what is sent to
  the model. Blocks persist across session resume (omp custom entries) and are
  dropped automatically if omp compacts the session.

### Summary shape — a request, not a gate

A summary is the only record of the span, so the tools ask for a structure:

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
- Deviations come back in the compress result as
  `摘要形状提示（已压缩，未拒绝）` — the compression always applies. A rejection
  costs a turn and the model re-sends the same draft anyway; the chain keeps the
  old text reachable, so a thin summary is recoverable rather than fatal.

## How it works

Every provider request fires omp's `context` event (confirmed LLM-only in
`pi-agent-core/src/agent-loop.ts` — the transform output goes to the provider
and is never written back to storage or the display transcript). On a clone of
the messages, DCP:

1. injects the `[anchor: session_start]` marker after the first user message,
2. elides the span from each live block's start anchor up to its compress call
   and strips the consumed-anchor blocks,
3. injects each block's summary right before its compress call, followed by one
   index line per absorbed ancestor.

`compress` resolves the anchor name on the persisted branch (positions are
stable; even consumed anchors remain findable there), validates the span,
absorbs the blocks it reaches back over, and records the block.

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

`DCP_REMIND_THRESHOLD` controls the token-pressure reminder: when the estimated
(post-compression) context crosses the threshold, a `[dcp:context]` reminder
naming the live anchors is appended to the LLM-facing context urging an
immediate `compress` — dcp is model-driven, and with omp auto-compaction
disabled a forgotten compress otherwise walks the context past the window and
stalls the session. Values: `(0,1)` = fraction of the model's context window
(default `0.4`), `>=1` = absolute tokens, `0` = disabled.

A second trigger fires without any token pressure:

- `[dcp:unit]` — the newest `todo` result reports a finished item set
  (`All items complete`, `Remaining items (0)`, `Remaining items: none.`). The
  work-unit boundary is observable rather than judged, so the reminder demands
  an anchor for the next unit plus a compress of the finished one. It fires once
  per finished result (deduped on the result's tool-call id).

There is no tool-call counter: a call count is not a context cost, and the
removed `[dcp:budget]` trigger fired three minutes into a session that then had
to re-read the files it had just explored.

One reminder at most is appended per request, with token pressure winning. The
token trigger recomputes on the transformed copy, so a compression silences it.
The reminder only ever touches the outgoing message copy; session history is
never modified.

## Verification

- `bunx tsc --noEmit` — type-checks clean. Without bun, `node node_modules/typescript/bin/tsc --noEmit`
  also works (Node 24 is enough).
- `bun smoke-test.ts` — exercises the full pipeline (anchor scanning, all three
  tools, transform, accumulation, chain recall/expand, session_start, advisory
  summaries, persistence round trip + v4 migration, session lifecycle, orphan
  cleanup) against synthetic omp messages, plus the reminder triggers.
  On a bun-less Windows host, with the resolver hook in `work/`:
  `node --experimental-strip-types --experimental-loader ./work/ts-resolve.mjs smoke-test.ts`.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
