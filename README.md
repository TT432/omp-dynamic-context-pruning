# omp-dcp — anchor-based conversation compression

Dynamic Context Pruning for [Oh My Pi (omp)](https://omp.ai), distilled to one
mechanism: **model-driven compression of conversation spans delimited by named
anchors** — without ever modifying session history. All transforms happen on
the copy of the conversation bound for the LLM; the persisted session stays
byte-for-byte intact.

Because omp counts context from the provider's real prompt-token report, the
savings are real: the context bar drops and omp's auto-compaction is deferred.

## What it does

Two tools are exposed to the model:

- **`add_anchor({ anchor })`** — places a named anchor at the call site. The
  tool call itself is the anchor: its provider-assigned `tool_use` id is a
  stable, globally unique identity. Names are unique per session;
  `session_start` is reserved.
- **`compress({ startAnchor, endAnchor, summary })`** — replaces the span
  between two anchors with a technical summary **the model writes itself**.

A virtual **`session_start`** anchor is always injected right after the
original user prompt, so everything since the beginning of the session can be
compressed while the prompt itself stays intact.

### Compression semantics

```
prompt · work1 · add_anchor(a1) · work2 · add_anchor(a2) · compress(a1, a2, desc)
```

becomes, in the LLM-facing context:

```
prompt · [anchor: session_start] · work1 · add_anchor(a2) · [Compressed: a1 → a2] desc
```

- Everything from the start anchor (inclusive) up to the end anchor
  (exclusive) is replaced by the summary, injected right after the end anchor.
- **The start anchor is consumed; the end anchor survives** — chain further
  compressions from it: `compress(a2, a3, desc2)` absorbs the previous summary
  (carry its key points into the new one).
- The `compress` call itself is hidden from future context.
- Invalid requests — unknown anchor, empty or reversed range, an end anchor
  already terminating or hidden inside an active compression, partial overlap —
  fail with an error and change nothing.
- Session history is never modified; compression only reshapes what is sent to
  the model. Compression blocks persist across session resume (omp custom
  entries) and are dropped automatically if omp compacts the session.

## How it works

Every provider request fires omp's `context` event (confirmed LLM-only in
`pi-agent-core/src/agent-loop.ts` — the transform output goes to the provider
and is never written back to storage or the display transcript). On a clone of
the messages, DCP:

1. injects the `[anchor: session_start]` marker after the first user message,
2. elides the spans and strips the consumed-anchor / compress-call blocks of
   every active compression block,
3. injects each block's summary right after its end anchor.

`compress` resolves anchor names on the persisted branch (positions are stable;
even consumed anchors remain findable there), validates the range, absorbs
fully-contained prior blocks, and records a compression block.

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

None. Set `DCP_DEBUG=1` in the environment to write per-pass context snapshots
and structured logs under `~/.omp/agent/logs/dcp/`.

## Verification

- `bunx tsc --noEmit` — type-checks clean.
- `bun smoke-test.ts` — exercises the full pipeline (anchor scanning, both
  tools, transform, chaining/consumption, session_start, validation errors,
  persistence round trip, session lifecycle, orphan cleanup) against synthetic
  omp messages.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
