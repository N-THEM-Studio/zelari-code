# ADR-0019 - Observation Integrity as an explicit clause of P1

- **Status**: accepted
- **Date**: 2026-08-17
- **Governance**: amendment of the ratified manifesto ([ADR-0010](0010-first-principles-manifesto.md)) - a clause under P1, not a new principle
- **Release**: v1.46 "Ground Truth"

## Context

The v1.46 release (the "Loud Tool Errors, Diagnostic Degradation, Shell Read-Only in Plan" plan) fixed three classes of false empties observed in real sessions: `grep_content` with a non-recursive glob reporting `filesInTree: 1` on trees of 117 files, `ast_outline` being silent on valid files (path not resolved against the root + four indistinguishable causes collapsed into `[]`), and the absence of a read-only shell in plan. An external hardening review asked to promote the underlying principle to an invariant: "OBSERVATION INTEGRITY".

The manifesto's method ("Method", ADR-0010) rules out adding it as a P7: the third test ("it is not derivable") fails - observation integrity derives from P1 (*do not trust an unverified assertion - including your own*: a false empty is an unverified assertion). The right shape is an explicit clause under P1.

## Decision

1. PRINCIPLES.md P1 gains an invariant box with the ratified text:

   ```
   OBSERVATION INTEGRITY
   A negative conclusion requires a successful and sufficiently scoped observation.
   EMPTY is evidence. DEGRADED is not evidence. ERROR is not evidence.
   TRUNCATED is partial evidence only.
   ```

2. P1's "How it is guaranteed" section extends the guarantee to the v1.46 mechanisms: discriminated statuses and sentinels in observation tools (`SEARCH_EMPTY_SCOPE`/`DEPRECATED_INPUT`/`filesWalked` in grep_content; `file-not-found` with the absolute path looked at, `typescript-unavailable`, `read-error` in ast/LSP; `degraded` + `artifactsWritten` and `unsupported_project_shape` in inspect_command).

3. The epistemic rule enters the plan and kraken (explore) prompts: "negative evidence is valid only from a completed observation. Never conclude that code/symbols/files do not exist from degraded results, zero files examined, or unavailable backends."

## Consequences

- An empty result is NEVER acceptable as proof of absence if the observation did not succeed and was not sufficiently scoped: the model must report the degraded status and broaden the observation, not conclude "the code does not exist".
- EMPTY is not fabricated from the degraded: tools must distinguish the causes and state them loudly (sentinel + machine fields `status`/`recoverable`/`recommendedFallback`).
- TRUNCATED counts only as partial evidence: no strong negative conclusions are built on it.
- The global rollout of `ObservationStatus` over ALL tools deferred to 1.47 (ADR in the v1.46 plan, section 8): in 1.46 the discriminated status lives only in the touched tools; usage data collected by the newly introduced fields will feed the future tool-health.

## Alternatives considered

- **P7 "Observation Integrity" as a new principle**: rejected - derivable from P1 (fails the method's third test).
- **Prompt rule only, without a box in the manifesto**: rejected - the review asked for it as an invariant stable across versions; a prompt alone is revocable policy, the manifesto is governance.
- **Global `ObservationMeta` on all tools right away**: rejected as scope creep before usage data (deferred to 1.47).