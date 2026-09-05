# ADR-0032 - Projection unification: the CLI budget pipeline is the canonical compiler (W4)

**Status:** Accepted
**Date:** 2026-08-30
**Promoted from:** `.zelari/decisions/015-adr-unificazione-proiezione-budget-pipeline-canonical.md` (2026-08-30) - Task: t44
**Prior:** ADR-0016/0021 (spine), W1 (graph on spine), W2 (context.projection)

## Context

Today there are **two parallel, diverging context-projection systems**:

1. **CLI budget pipeline** (`src/cli/budget/`: tokenBudget + llmCompact + persistCompact, orchestrated by `buildModelContext` in `src/cli/budget/modelContextBuilder.ts`): spine-aware, emits `session.compacted` with fingerprint/strategy/saved tokens, and is the one feeding the main loop (TUI, headless, council).
2. **Core `ContextProjector`** (`packages/core/src/context/ContextProjector.ts`): does not know the spine; its only production consumer is the tentacles' parent-context (`taskTool.ts`).

Building HarnessState (a typed read-model over the spine) on top of two systems forced choosing one or creating a third.

## Decision

**The CLI budget pipeline is the canonical compiler of turn context. No third system.**

1. `ContextProjector` is not extended: its scope is explicitly declared as **tentacle parent-context** (the only real consumer) and it will be documented as such in the file; it never becomes the source of the main loop's context.
2. HarnessState **does not compile context**: it is a read-model reading what has already been decided and logged - `session.compacted` events + `context.projection` notes (W2) + turn envelope. It observes, it does not project.
3. If in the future ContextProjector were needed in the main loop, the path is to **absorb it into the budget pipeline** (becoming one of its strategies), not the other way around.

## Consequences

- The path to HarnessState is free of ambiguity: it consumes the spine, with no dependencies on the pipeline or the projector.
- The docstring/scope declaration on `ContextProjector.ts` is the only required code touch (a comment, no behavior); full declassification (deprecation) is deferred to 2.x - tentacle parent-context remains a legitimate consumer.
- Every new projection metric goes on the spine (W2 pattern), never on a side channel.

## Alternatives considered

- **ContextProjector as the single compiler**: rejected - not spine-aware, lacking the already-proven compaction telemetry; migrating the main loop would be a high-risk rewrite for zero gain.
- **A brand-new "unified" third system**: rejected - maximum risk, duplication, and HarnessState would become the fourth projection.