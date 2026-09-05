# ADR-0021 - Session spine v1 contract

**Status:** Accepted
**Date:** 2026-08-19

## Context

ADR-0016 defines *what* it wants (a single append-only log as source of truth) but not the operational contract. The CLI migration (render from events, resume/fork UX) requires a stable format before touching the hosts.

## Decision

The `@zelari/core/session` module implements spine v1 with this public contract:

- **Envelope** (`SessionEventEnvelope`): `{schemaVersion: 1, sessionId, seq, ts, kind, actor, data}` -
  one JSON line per event; `kind` belongs to `SESSION_EVENT_KINDS` (a closed vocabulary,
  extendable only with a schema minor or a new schemaVersion).
- **Writer** (`SessionLogWriter`): single-writer with a `wx` lock + stale takeover;
  `seq` assigned after Zod validation; chained appends (on-disk order guaranteed).
- **Replay** (`readSessionLog`): tolerant - corrupt lines skipped and reported as
  `ReplayIssue` (`corrupt-line`, `seq-gap`, `seq-duplicate`, `seq-nonmonotonic`,
  `schema-mismatch`); never an exception on a partial log.
- **Projection** (`buildProjection`): derived views (messages, tool counts,
  verification summary, fork lineage) - no persisted parallel state.
- **Single model path** (`deriveMessages` + `isModelSurfaceEvent`): only surface kinds
  enter the history; the P1 invariant "model-visible implies logged" is statically
  checkable on the vocabulary.
- **Lineage**: `forkSession` (copy = fromSeq + `session.forked` event),
  `resumeSession` (reopen + `session.resumed`), `lineageOf` (ancestor chain).
- **Export**: `zelari-session-export/1` format (machine-readable, lock-free).

## Alternatives considered

1. **Extend the `sessionJsonl.ts` sidecar** - rejected: it lacks seq/lock/version and its
   shape is tied to `BrainEvent` (a live stream with `message_delta`, not a timeline).
2. **SQLite** - deferred (as in ADR-0016): JSONL stays grep-able and append-only.

## Consequences

**Positive** - deterministic resume/fork/export on the trajectory plane; fake
"done" reconstructible; the base for comparable profiles (same task -> same event schema).

**Negative** - the closed vocabulary requires contribution discipline; replay of very
long sessions will need cursor/snapshot mitigation (next phase, not blocking).

References: `packages/core/src/session/`, `docs/plans/gap-map-model-visible.md`.