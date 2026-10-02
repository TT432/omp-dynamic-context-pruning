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
- **`compress({ startAnchor, summary })`** — replaces everything from the
  start anchor up to the compress call itself with a technical summary **the
  model writes itself**. The end of the span is implicit: the compress call's
  own position.

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

`DCP_REMIND_THRESHOLD` controls the over-threshold compress reminder: when the
estimated (post-compression) context crosses the threshold, a reminder naming
the live anchors is appended to the LLM-facing context urging an immediate
`compress` — dcp is model-driven, and with omp auto-compaction disabled a
forgotten compress otherwise walks the context past the window and stalls the
session. Values: `(0,1)` = fraction of the model's context window (default
`0.8`), `>=1` = absolute tokens, `0` = disabled. The reminder only ever
touches the outgoing message copy; session history is never modified.

## Verification

- `bunx tsc --noEmit` — type-checks clean.
- `bun smoke-test.ts` — exercises the full pipeline (anchor scanning, both
  tools, transform, accumulation/absorption, session_start, validation errors,
  persistence round trip, session lifecycle, orphan cleanup) against synthetic
  omp messages.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
