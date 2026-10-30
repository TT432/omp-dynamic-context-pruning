# omp-dcp — anchor-based conversation compression

Dynamic Context Pruning for [Oh My Pi (omp)](https://omp.ai), distilled to one
mechanism: **model-driven compression of conversation spans from a named
anchor up to the compress call** — without ever modifying session history. All transforms happen on
the copy of the conversation bound for the LLM; the persisted session stays
byte-for-byte intact.

Because omp counts context from the provider's real prompt-token report, the
savings are real: the context bar drops and omp's auto-compaction is deferred.

## What it does

Two tools are exposed to the model:

- **`add_anchor({ anchor })`** — places a named anchor at the call site. The
  tool call itself is the anchor: its provider-assigned tool-call id is a
  stable, globally unique identity. Names are unique per session;
  `session_start` is reserved.
- **`compress({ startAnchor, summary, force? })`** — replaces everything from
  the start anchor up to the compress call itself with a **slot-structured
  summary the model writes itself** (see below). The end of the span is
  implicit: the compress call's own position.

A virtual **`session_start`** anchor is always injected right after the
original user prompt, so everything since the beginning of the session can be
compressed while the prompt itself stays intact.

### Compression semantics

```
prompt · work1 · add_anchor(a1) · work2 · work3 · compress(a1, desc)
```

becomes, in the LLM-facing context:

```
prompt · [anchor: session_start] · work1 · [Compressed: a1 → here] desc · compress(a1, desc)
```

- Everything after the start anchor up to the compress call is replaced by
  the summary, which takes the span's place right before the compress call.
- **The start anchor is consumed; the compress call and its confirmation
  stay in context** — later turns can see that the compression happened.
- Earlier compressions whose compress call lies before the start anchor stay
  in place: their summaries and yours **accumulate in order**. A span that
  reaches back across a prior compression absorbs it — carry its key points
  into the new summary.
- Invalid requests — unknown anchor, empty range, a start anchor lying inside
  an active compression — fail with an error and change nothing.
- Session history is never modified; compression only reshapes what is sent to
  the model. Compression blocks persist across session resume (omp custom
  entries) and are dropped automatically if omp compacts the session.

### Summary schema

A free-form summary is a lossy paraphrase: what the model omits is gone, and
nothing in the text lets a later turn tell a remembered fact from an invented
one. Every summary therefore has a **fixed slot structure**, validated before
any state changes:

```
## 当前任务        - 正在做的事 证据: <定位>
## 已完成          - 动作/结论 证据: <定位>
## 未完成          - 下一步具体动作 证据: <定位>
## 约束            - 用户要求/不变量 证据: <定位>
## 文件与命令      - 关键路径/命令 证据: <定位>
## 在跑作业与句柄  - 作业/子代理/端口 证据: <定位>
```

- Slots appear once each, in that order; a slot with nothing to report is a
  single `- 无`; `当前任务` may never be `无`.
- Every fact is a `- ` bullet ending in `证据: <定位>` — an externalized
  pointer (path, `file:line`, session id, tool name, command), **not** pasted
  content. Facts are capped at 600 characters so summaries stay pointers
  rather than copies.
- `session_start` + `force: true` gets the **strict tier**: `已完成` and
  `未完成` must carry real content and every evidence pointer must be a real
  locator. That cost is deliberate — the more a summary throws away, the more
  it must prove.
- A compress that absorbs a prior block must **merge** it: every locator
  (path, `file:line`, `` `identifier` ``, CONSTANT) that block recorded under
  `已完成` / `约束` / `文件与命令` has to appear in the new summary. Keep the
  locator and mark obsolete facts `已废弃: <原因>`; dropping one is rejected
  with the missing locators listed, and nothing is compressed. Slot structure
  alone does not prevent loss — the content is what must survive.

## How it works

Every provider request fires omp's `context` event (confirmed LLM-only in
`pi-agent-core/src/agent-loop.ts` — the transform output goes to the provider
and is never written back to storage or the display transcript). On a clone of
the messages, DCP:

1. injects the `[anchor: session_start]` marker after the first user message,
2. elides the span from each block's start anchor up to its compress call and
   strips the consumed-anchor blocks,
3. injects each block's summary right before its compress call.

`compress` resolves the anchor name on the persisted branch (positions are
stable; even consumed anchors remain findable there), validates the range,
absorbs fully-contained prior blocks, and records a compression block.

Compared to quoting verbatim text anchors (the previous design), named anchors
are unambiguous by construction — no substring matching, no ambiguity
rejection, no drift when messages change.

## Installation

This is a source extension (a directory with `package.json` declaring
`omp.extensions`). Add it to your omp config:

```yaml
# ~/.omp/agent/config.yml   (or <project>/.omp/config.yml)
extensions:
  - /path/to/omp-dcp
```

Restart omp. The model gets the `add_anchor` and `compress` tools.

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

Two further triggers fire without any token pressure:

- `[dcp:unit]` — the newest `todo` result reports a finished item set
  (`All items complete` / `Remaining items (0)`): the work-unit boundary is
  observable rather than judged, so the reminder demands an anchor for the
  next unit plus a compress of the finished one.
- `[dcp:budget]` — N tool calls have run since the last compress.
  `DCP_REMIND_TOOLCALLS` sets N (default `40`, observed unit size
  ~36 calls/todo item in 20 sessions), `0` = disabled. N is measured against
  the durable watermark `compress` writes, not against a scan for a compress
  call in the message stream: a compression issued through the eval kernel or
  any programmatic caller leaves no `write({path:"xd://compress"})` block, and
  the old scan therefore never reset (live: 60 → 85 claimed overruns after a
  compression that had already happened).

One reminder at most is appended per request, with priority
token > unit > budget. The token and unit triggers recompute on the
transformed copy, so a compression silences them; the budget trigger resets
because `compress` moved the watermark. The reminder only ever touches the
outgoing message copy; session history is never modified.

## Verification

- `bunx tsc --noEmit` — type-checks clean. Without bun, `node node_modules/typescript/bin/tsc --noEmit`
  also works (Node 24 is enough).
- `bun smoke-test.ts` — exercises the full pipeline (anchor scanning, both
  tools, transform, accumulation/absorption, session_start, validation errors,
  persistence round trip, session lifecycle, orphan cleanup) against synthetic
  omp messages, plus the three reminder triggers. On a bun-less Windows host:
  `node --experimental-strip-types --experimental-loader <loader> smoke-test.ts`
  with a resolver hook that maps extensionless relative imports to `.ts` files.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
