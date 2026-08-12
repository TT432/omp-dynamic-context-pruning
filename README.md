# omp-dcp — anchors + SkillZip for omp

An [Oh My Pi (omp)](https://omp.ai) extension with two independent mechanisms:

- model-driven compression of conversation spans delimited by named anchors,
  without modifying session history; and
- evaluation-free persistent skill evolution based on the SkillZip typed-contract
  and hard-coverage design (arXiv:2608.11079).

Because omp counts context from the provider's real prompt-token report, the
savings are real: the context bar drops and omp's auto-compaction is deferred.

## Anchor compression

Two anchor tools are exposed to the model:

- **`add_anchor({ anchor })`** — places a named anchor at the call site. The
  tool call itself is the anchor: its provider-assigned tool-call id is a
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
prompt · [anchor: session_start] · work1 · [Compressed: a1 → a2] desc · add_anchor(a2)
```

- Everything from the start anchor (inclusive) up to the end anchor
  (exclusive) is replaced by the summary, which takes the span's place right
  before the end anchor.
- **The start anchor is consumed; the end anchor survives** — chain further
  compressions from it: `compress(a2, a3, desc2)` leaves earlier summaries in
  place, so they accumulate in order (`desc1, desc2, …`). A new span that
  fully contains a prior compressed span absorbs it — carry its key points
  into the new summary.
- The `compress` call and its success confirmation stay in context, so later
  turns can see that the compression happened.
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

## SkillZip evolution

The essential **`skillzip`** tool supports `create`, `update`, `compress`,
`audit`, `inspect`, `status`, and `list`. It stores deployable skills at
`~/.omp/agent/skillzip/<name>/SKILL.md`, with a private `.skillzip.json`
typed-contract sidecar and crash-recovery WAL in the same directory.

SkillZip runs without global `AGENTS.md` evolution rules. The extension itself:

1. appends a stable evolution contract in `before_agent_start`;
2. offers one hidden capture continuation after a substantive turn (five
   successful tool calls), while allowing explicit calls at any time;
3. scans Markdown into stable cited blocks and asks a configured `@smol` model
   only for schema-constrained contract extraction;
4. validates citations, workflow edges, tool names/arguments, scopes, and
   modality in the host;
5. deterministically deduplicates compatible rules, lifts rules only when every
   direct child scope is covered, and extracts repeated workflows only when the
   rendered token saving is positive;
6. renders an ordinary `SKILL.md`, audits every required unit, restores the
   shortest cited source block if coverage is missing, then atomically commits
   text and sidecar.

Unique, rare, ambiguous, code, and table content is never discarded merely for
being infrequent. If no model is available or extraction fails, every source
block becomes locked residual and is preserved verbatim.

## Installation

This is a source extension (a directory with `package.json` declaring
`omp.extensions`). Add it to your omp config:

```yaml
# ~/.omp/agent/config.yml   (or <project>/.omp/config.yml)
extensions:
  - /path/to/omp-dcp
```

Restart omp. The model gets `add_anchor`, `compress`, and the essential `skillzip` tool. `create` and `update` ask live hosts to reload resources; otherwise the skill is discovered on the next omp start.

## Configuration

None. Set `DCP_DEBUG=1` in the environment to write per-pass context snapshots
and structured logs under `~/.omp/agent/logs/dcp/`.

## Verification

- `bun run typecheck` — type-checks the extension and both smoke suites.
- `bun run test` — runs the existing anchor pipeline regression suite plus
  SkillZip scanner, extraction validation, hard coverage, compatible sharing,
  Zip-on-Write, fallback, audit recovery, transaction rollback, path safety,
  and AGENTS-independent lifecycle contracts.

See [`docs/design.md`](./docs/design.md) for the architecture and invariants.

## License

AGPL-3.0-or-later, matching upstream DCP. See [`LICENSE`](./LICENSE).
