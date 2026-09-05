# ADR-0024 - Closing the dual-write: the spine as the only source of model context

**Status:** Accepted (amended 2026-08-30; v1.1 2026-08-30)
**Date:** 2026-08-19

## Context

ADR-0016 defined the session spine contract (append-only JSONL log, "model-visible implies logged" invariant), but during the alpha the wiring remained **dual-write**: the 1.x in-process store (`hooks/conversationContext.ts`) and the BrainEvent JSONL sidecar were the "transcript of record", while the spine was a best-effort mirror (`SessionSpineMirror`, `sessionSpine.ts`). The model's context was built from the legacy store/`--history`, not from the spine.

With slices E1.1-E1.4 (2.0.0-alpha.5) the flows were inverted:

- **E1.1** - single adapter `derivedToAgentMessages()` in `@zelari/core/session` (`DerivedMessage[] -> AgentMessage[]`), with documented losses.
- **E1.2** - headless (kraken/council/zelari): `--history` becomes a one-shot import into the spine (`seedHeadlessModelHistory`); resume derives from the log.
- **E1.3** - TUI: `dispatchPrompt` derives the seed from the spine before logging the prompt; the store remains a declared fallback.
- **E1.4** - Desktop: resume via the `session_started` event + `--resume <id>`; the 1.x snapshot remains the import fallback.
- **E1.6/E1.7** - deterministic replay from `events.jsonl` alone and the model-visible-implies-logged invariant as a CI gate (`npm run test:session`).

Residual at the time of this ADR: the **budget pipeline** (single and council) still measured `getHistory()` (the 1.x store) instead of the spine-derived seed, and the council path compacted the store without emitting `session_compacted` on the spine (compaction boundary drift).

## Decision

1. **The spine is the only source of model context** on every hot path (headless kraken/council/zelari, TUI single/council). Every harness seed goes through `deriveMessages()` -> `derivedToAgentMessages()` / `derivedModelSeed()`. No new history builder: whoever needs context derives from the spine.
2. **The 1.x store and the BrainEvent sidecar are mirror surface** (UI render, export, migration), not source of truth. `sessionManager.ts` is deprecated for model context: UI persistence (`/sessions`, `/resume`, markers) and read-only source for migration.
3. **The budget pipeline measures the spine-derived seed** (`historyForModel` / `councilHistory`), not the store. If the pipeline compacts, the replay replaces the current turn's seed and the `session_compacted` event is emitted on **both** paths (single and council), so the next derive sees the compaction boundary.
4. **Declared discrete fallback**: spine degraded/disabled -> seed from the 1.x store (pre-spine behavior), tested. A spine error never breaks the turn.
5. **`ZELARI_SESSION_SPINE=0` is an emergency/debug kill switch**, not a release default.
6. **Dual-write removal at 2.0.0-rc**: when replay/invariant are stable for a full cycle (C1-C3 closed), the 1.x store stops feeding the fallback and becomes pure UI/export view; the final removal will be the subject of a separate ADR.

## Alternatives

- **Keep dual-write indefinitely** - rejected: two brains diverge (the v0.4.2 split-brain bug), compaction was not visible to the derived model, and every feature (resume, fork, export, verification) had to be implemented twice.
- **Big-bang single-write without fallback** - rejected: a spine I/O failure would make the product unusable; the discrete fallback is the turn's safety policy (P3).
- **Derive model context from the 1.x BrainEvent sidecar** - rejected: the 1.x log does not record user prompts (a P1 hole) and has no reliable compaction boundaries.

## Consequences

- **Positive**: a single history to reconstruct (replay verified in CI); resume/fork/export work from the same log; compaction is visible to the model; the `@zelari/core/session` contract is the only context API.
- **Negative**: the derive pays an I/O cost per turn (incremental read mitigated by the projection cache); during the alpha two representations still exist to keep aligned (the mirror).
- **Neutral**: the builders `buildAgentUserWithHistory` / `buildCouncilTaskWithHistory` remain prompt formatters - they receive only spine-derived input and are covered by the replay tests.

## TODO

- [x] E1.5 - budget pipeline on the spine-derived seed + `session_compacted` on the council path
- [x] Architectural test `legacyContextIsolation.test.ts` (no store fallback for model context)
- [ ] At 2.0.0-rc: evaluate removing the store fallback -> later ADR

## Amendment (2026-08-30) - graph host on the spine (W1, release 2.17)

With 2.17 the list of **hot paths** in Decision point 1 extends to the **graph host**: `runHeadlessKrakenGraph` (`src/cli/runHeadless.ts`) opens the session log (`openHeadlessSpine`, mode `kraken`, resolved workspace), gates `session.started` on `--output json`, and closes it on every exit (completed/error/cancelled, including handled SIGINT); a spine failure never changes the exit code. The graph host no longer bypasses this ADR on default-on runs.

**Declared special-case - spine v1 coverage on graph runs: ENVELOPE-ONLY.** On graph runs the spine log contains the run's envelope events (`started` / `user.message` / `ended`) plus node-independent host session-level scaffolding (`session.harness_manifest`, `note`, `resource.*`, `task.contract`, written by the mirror at every open/turn-prep, identical with an empty or populated graph); **per-node** events and the tentacles' **inner turns** do NOT land on the spine log in v1 (tentacles write to the kraken radio JSONL channel, not the spine). The contract is pinned by a differential test in `src/cli/krakenGraphSpine.test.ts` (empty-graph run vs 1-node graph: identical spine sequence). It is a declared special-case contract, not full coverage: deepening (per-node events on the spine) is deferred.

- [ ] Deepen per-node coverage of graph runs on the spine (post-v1)

## Amendment v1.1 (2026-08-30) - per-node envelope on graph runs

**Replaces the envelope-only special-case** of the 2026-08-30 amendment (the "Deepen per-node coverage" TODO above is closed by this amendment). On graph runs the spine now also carries the **per-node envelope**: state events `graph.node_started` / `graph.node_ended` (added to the closed vocabulary of `packages/core/src/session/types.ts` with schema review per ADR-0021 - additive state-only types, **without a SCHEMA_VERSION bump**, which stays 1: older tolerant readers flag them as `schema-mismatch` and skip them, and `deriveMessages()` does not change - they are not model-surface).

**Who writes - the HOST only.** Emission lives in `runHeadlessKrakenGraph` (`src/cli/runHeadless.ts`): the host wraps the tentacle run seam (`runTentacleFn`, helper `nodeSpineEnvelopeRun`) - the same one the executor invokes for each node turn - and appends the started/ended pair via `spine.appendEvent` with `actor: system`. Tentacles/subagents NEVER write to the spine (neither the test stub nor the real code): ADR-0024's single-writer does not change.

**What goes on the spine - envelope/metadata only.** Declared payload: `nodeId`, `agent`, `graphId?` on started; `nodeId`, `agent`, `graphId?`, `ok`, `cancelled?` (only on a cancelled run) and host-measured `durationMs` on ended. One pair per **attempt** (retry/rework = a new pair); `merge` nodes do not drive a tentacle and stay radio-only. No model content: node label, prompt, assistant text, tool output do NOT land on the spine - they stay on the kraken radio JSONL channel (`node_start`/`node_end` with `detail`), correlated by the same `sessionId`.

**Contract pinned** by the updated differential test in `src/cli/krakenGraphSpine.test.ts` (empty-graph run vs 1-node graph with a real turn: the 1-node run adds EXACTLY the `graph.node_started`/`graph.node_ended` pair to the empty-graph sequence - remove the pair and the sequences coincide kind-for-kind; absent `tool.call`/`tool.result`/`assistant.message`/`verification.*`; no spine payload contains turn content).