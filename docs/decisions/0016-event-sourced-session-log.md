# ADR-0016 - Event-sourced session log as the single source of truth

**Status:** Accepted
**Date:** 2026-08-19 (ratified; proposed 2026-08-18)

## Context

Today a session's "state" is reconstructed by **multiple parallel writers/readers**, each with its own semantics, which can diverge from one another:

- `sessionManager.ts` - JSONL sidecar + `current.txt` marker of the current session.
- `state/fileStateStore.ts` - durable state (plan/risks/ADR) separate from the event log.
- `checkpoint/checkpointManager.ts` - git refs **are** the persistence ("no separate metadata file to drift").
- `traceStore.ts` - structured traces for the fan-out/trace view.
- `hooks/eventsToMessages.ts` - events-to-messages reconstruction for transcript and compaction.
- `compaction.ts` + `budget/llmCompact.ts` - history compaction.
- `state/restoreState.ts` / `state/loadDurableContext.ts` - resume/restore.

The best-known symptom is the *split-brain* bug documented in `sessionKindRouter` (v0.4.2): the router wrote `idA` to disk while the hook wrote `idB` in memory/writer. Root consequence: fork, resume, transcript, telemetry and compaction **are not guaranteed to agree**, because each re-derives state its own way.

*Idea origin:* the "model-visible implies logged" invariant and the append-only log as the single source of truth were inspired by deepseek-harness (Cordis), adapted without vendoring the framework.

## Decision

Adopt a **single append-only JSONL stream of `SessionEvent`** as a session's source of truth, with the central invariant:

> **"model-visible implies logged"** - everything that reaches the model (system prompt fragments, user messages, assistant deltas, tool calls, tool results, compaction boundaries, usage/tokens) is reconstructible from the log, verified by an assert at the message-assembly point (active only in dev/CI, never in production).

Operational rules:

1. **One writer** (`appendEvent()`) and **one reader** (`replaySession()`); no other module keeps parallel conversation state.
2. **Consumers derive materialized views** (message arrays, token budget, transcript, telemetry, costs) by replaying the log, with an optional incremental cursor to avoid a full replay every turn.
3. **Git checkpoints** remain, but as *named pointers* inside the log timeline (the log is the durable base; git refs are indexes, not duplicates).
4. The format is **versioned** with a monotonically increasing `SCHEMA_VERSION` (tied to `MIGRATION.md`), so migrations become mechanical instead of "from memory".

## Alternatives considered

1. **Keep the parallel stores + periodic reconciliation** - rejected: drift between stores is the root cause; reconciling after the fact does not eliminate it.
2. **Full Cordis port** (event-emitter with reversible effects, ~100 packages) - rejected: a huge jump, a different lifecycle model, and it violates the "zero new heavy dependencies" convention. We adopt the *idea*, not the framework.
3. **SQLite instead of JSONL** - deferred: JSONL is append-only friendly, grep-able and already the on-disk shape; SQLite can be a later optimization if random access becomes the bottleneck.

## Consequences

**Positive**

- A single invariant to test ("model-visible implies logged") instead of N mechanisms.
- Fork, resume, transcript, compaction and telemetry agree by construction.
- The refactor has the highest ROI: it is the base compaction, checkpoint, transcript and costs already rest on.

**Negative / residual**

- Migration from the existing scattered stores (incremental work, not big-bang).
- Replay cost for long sessions - mitigated by compaction snapshots + cursor.
- The assert will surface pre-existing latent drift (good, but requires cleanup before enabling it).

## Ratification (2026-08-19) - integrated decisions

1. **Location (was an open TODO):** sessions live at project level in `<workspaceRoot>/.zelari/sessions/<sessionId>/events.jsonl`, with an override via env `ZELARI_SESSIONS_DIR` (tests/CI/Desktop multi-cwd). The legacy path `~/.tmp/zelari-code/sessions/` (sidecar `sessionJsonl.ts`) stays readable but is read-only compat: no new writes to the sidecar by the spine.
2. **Single writer with ownership lock:** `<sessionDir>/writer.lock` created with `flag:'wx'` contains `{ownership, pid, ts}`; a second writer gets `SessionLogLockedError`. Takeover allowed only on a stale lock (`staleLockMs`, default 10 minutes).
3. **Gapless monotonic `seq`:** starts at 1, incremented by the writer after Zod validation of the envelope; replay reports `corrupt-line`, `seq-gap`, `seq-duplicate`, `seq-nonmonotonic` as `ReplayIssue` without ever crashing.
4. **`SCHEMA_VERSION = 1`** in the envelope of every line; mechanical migrations documented in `MIGRATION.md`.
5. **Surface vs state events:** `isModelSurfaceEvent` is the only predicate deciding what enters `deriveMessages`; everything else (task, note, mission, verification) is derivable state-event but not model-visible by default.
6. **Lineage:** `forkSession` copies events up to `fromSeq` into a new session and appends `session.forked {parentSessionId, parentSeq}`; `resumeSession` reopens the log and appends `session.resumed`.
7. **Coexistence with `plan.json` (ADR-0018):** the file remains the cross-session store; the spine logs per-session `task.created`/`task.updated` transitions. The file is the index, the log is the timeline.

## TODO

- [x] Define the `SessionEvent` schema v1 with `SCHEMA_VERSION`.
- [x] Introduce the single writer `appendEvent()` and the reader `replaySession()` (`packages/core/src/session/`).
- [ ] Wire the "model-visible implies logged" assert into message assembly (dev/CI only).
- [ ] Migrate consumers: `eventsToMessages`, `compaction`, `traceStore`, telemetry, `restoreState`.
- [ ] Treat git checkpoints as named pointers in the log timeline.