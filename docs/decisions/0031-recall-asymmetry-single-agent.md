# ADR-0031 - Recall asymmetry on single-agent paths (W3)

**Status:** Accepted
**Date:** 2026-08-30
**Promoted from:** `.zelari/decisions/014-adr-asimmetria-recall-single-agent.md` (2026-08-30) - Task: t43
**Prior:** ADR-0016/0021 (spine), W2 (context.projection telemetry)

## Context

MemoryV2 today is **write-only on single-agent paths** (kraken TUI chat, `runOneTurn`):
- at turn end `remember` is called (facts land in the SQLite backend);
- but no host passes `memoryService` to the `AgentHarness` (`config.memoryService?`, `AgentHarness.ts` L287-295) -> `prepareMemoryContext()` (L1233) is a no-op -> **zero injection** of durable context;
- recall happens only where the host explicitly calls `buildContext` (council prompt `memoryHits`) or where MemoryV2 is pinned (desktop sidecar);
- scoring (`packages/core/src/memory/scoring.ts`) sees no budget/cost signals.

Before building on top of it (HarnessState, learned policy) we must decide whether the asymmetry is a bug or a choice.

## Decision

**The asymmetry is deliberate at this stage and becomes a measurable opt-in, not a silent default.**

1. Single-agent stays **without injected recall** by default: single turns stay lean, memory accumulates cross-session value and for the council/graph paths that already consume it.
2. The "recall everywhere" case is not enabled blindly: it is evaluated after W2 using the `context.projection` signal on the spine (`contextChars`, `returnedCount`, `durationMs` per turn). Gate to enable recall on a path: **correctness = baseline** (eval `tools/eval`) **and** token/latency cost within the path's declared budget.
3. When enabled, the channel is the already existing one: `AgentHarness.config.memoryService` + `memoryQuery` (NO second injection path).

## Consequences

- No immediate code change required by this ADR (the decision is "documented status quo + measurable gate").
- W2 makes the gate evaluable: without `context.projection` the point-2 condition was not verifiable.
- Scoring without cost signals remains an accepted limit; if the (future) learned policy must weigh cost, `MemoryEvent` will be extended (identifiers/counters only, never content).

## Alternatives considered

- **Recall default ON everywhere**: rejected - it changes the context of every single-agent turn without a comparison baseline; silent-regression risk.
- **Remove remember from paths without recall**: rejected - it loses the cross-session value the council/graph paths already use.