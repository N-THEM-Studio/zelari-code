# ADR-0020 - Kraken plan-safe explore task

- **Status**: accepted
- **Date**: 2026-08-18
- **Governance**: prerequisite slice of the "Kraken Verified Selection" plan (Phase 0/1), standard Kraken only - no Graph integration
- **Release**: next minor

## Context

The Verified Selection plan (multi-candidate exploration in PLAN/BUILD) requires the `task` tool to be able to spawn explore tentacles in the PLAN phase. Today three primitives prevent or weaken this:

1. `createBuiltinToolRegistry` registers `task` only with `!options.planMode` (`enableTask`), so PLAN cannot parallelize research.
2. `planMode` and `readOnly` are coupled in the same derived variable: separating the task required care not to open mutators.
3. The standard task tool propagates to the tentacle neither the provider/model resolved by the turn (tentacles fell back to the persisted default of `provider.json`, diverging from the user's selection - a problem already fixed only on the kraken-graph path) nor the turn's cancellation signal (`runTentacle` supports `opts.signal` but `execute` did not pass it).

## Decision

1. **Plan-safe explore task**: the registry in `planMode` still registers `task`, but with `TaskToolPolicy.allowedAgents: ['explore']`. The policy is enforced at three levels: a restricted zod enum (conforming providers cannot emit `general`/`verify`), an explicit gate in `execute` BEFORE consuming the spawn budget, and a `RESTRICTED` suffix in the description visible to the model. Opt-out: `planExploreTask: false` restores the pre-ADR behavior (no `task` in PLAN). The `explore` profile stays read-only, so PLAN gains no write/exec reach.
2. **Provider/model anchoring**: `CreateRegistryOptions` accepts `subAgentProvider`/`subAgentModel`, forwarded to `createKrakenSubAgentContextFactory` (which already supported the overrides for the graph path). The TUI (`useChatTurn`) passes the turn's resolved provider/model when present; headless (`runHeadlessSingle`) passes the run's resolved provider/model. Those who do not pass them keep the previous behavior (persisted fallback).
3. **Cancellation propagation**: `execute` passes `ctx.signal` to `runTentacle`, which already forwards it to `runSubAgent` (generator unwind: the tentacle stops before the next tool call and does not keep writing after the parent's cancellation).
4. **Scope invariants (Phase 0)**: feature target = standard Kraken only; Graph behavior does not change (graph/fanout call-sites untouched); PLAN stays project read-only; candidate tentacles (future) will be explore-only; in v1 the maximum number of candidate implementations is zero; the default verifier will be exactly the parent model.

## Consequences

- PLAN can spawn only `explore`; `general`/`verify` are rejected with a clear error without consuming the spawn budget.
- BUILD (full profile, non-plan) is unchanged: same tools, same unlimited policy, same pre-ADR behavior.
- Explicitly `readOnly` registries and sub-profiles (`explore`/`verify`/`general`) do not register `task` (anti-recursion): unchanged.
- `inspect_command` and the mutators stay tied solely to the derived `readOnly` variable (which still includes `planMode`): the separation concerns only the `task` tool.
- TUI/Desktop selection now also governs standard-task tentacles (before: only the parent), aligning the standard path with what the graph path already did.
- Tests: `src/cli/tools/taskTool.planSafety.test.ts` covers registry gating, explore-only policy, restricted enum, signal propagation and BUILD/readOnly/sub-profile regressions.

## Alternatives considered

- **Register the task in PLAN without a policy** (relying only on the caller's explore profile): rejected - the parent model could emit `agent=general` and the general tentacle would write outside the plan contract.
- **Gate only at the prompt level**: rejected - policy revocable by the model; the invariant must live in the runtime.
- **Fully decouple `readOnly` from `planMode`**: deferred - it would have touched mutators/bash/inspect_command/world-model/ssh/browser together; not necessary for Phase 1 and outside the minimal-diff principle.