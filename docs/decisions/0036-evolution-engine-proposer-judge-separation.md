# ADR-0036 - Evolution Engine: proposer/judge separation

- **Status:** Accepted (v0: documentation + mechanical gate; runtime opt-in in later phases)
- **Proposed:** 2026-09-04
- **Author:** Zelari Code (BUILD phase, on verification of the user's suggestions)
- **Depends on:** `tools/eval/evolvePropose.ts`, `tools/eval/evolveDecide.ts`, `tools/eval/evolveValidate.ts` (proposal engine already existing, zero self-mutation), `scripts/verify-principles.mjs` (P1-P6 gate), [ADR-0019](./0019-observation-integrity-p1-clause.md), [ADR-0023](./0023-deterministic-verification-completion.md), [PRINCIPLES.md](../../PRINCIPLES.md) (P1 invariant).

## Context

The repo already has all the pieces of an evolutionary cycle, but unlinked: `skill-stats` and `council-feedback`, `/promote-member`, the retention gate with manifest hash, checkpoint/rollback, and - often underestimated - a `evolve:propose`/`evolve:decide`/`evolve:validate` pipeline in `tools/eval/` that already implements a **propose -> decide (human) -> validate** loop with an append-only store and an explicit ban on self-mutation.

The external proposal of an "Evolution Engine" is therefore right in direction but underestimates what exists: the engine does not need building, the loop needs **closing around what is there** - and first of all a constitution must be fixed that prevents the engine from corrupting its own judge.

The structural risk: any mechanism optimizing against metrics learns the metrics (Goodhart). If the evolutionary cycle could touch what decides safety (P2) or measures fitness (P1), those principles would become prompt promises - exactly what P2 forbids.

## Decision

**Evolve the "governable genome", never the "judge".** The separation of powers is mechanically enforced by `JUDGE_PATHS` in `scripts/verify-principles.mjs` (`judge` check, hard in CI):

1. **Genome** (what can evolve, with human confirmation for every scope jump beyond the session): `SKILL.md` (built-in and user), council role prompts and per-role tool budgets, routing policy per task class, tentacle `scope[]`/`acceptance[]` templates, memory recall/consolidation heuristics, **proposals** of new eval anchors.
2. **Judge** (outside the genome by constitution): `ToolRegistry.invoke` and the lifecycle-hooks choke-point, sandbox and shell blocklist, folder trust and permission policy (`src/cli/safety/`), honesty lint and tier ranking (`packages/core/src/council/verification/`), Tier-0 anchor evals (`eval/anchors/`), the deterministic gate runner (`tools/eval/runGate.ts`), the retention gate (`.github/workflows/eval-retention-gate.yml`), and this very gate (`scripts/verify-principles.mjs`).

Operational rules:

- **The engine that proposes is not the engine that measures. No artifact can promote itself.** An LLM judgment is worth at most a `claimed` tier (evidence ladder): it can propose, it cannot promote. PASS authority stays with the deterministic gates (anchors, tier ranking, CompletionPolicy - ADR-0023).
- **Reuse, not rebuild:** the loop is `evolvePropose` -> `evolveDecide` (human decision, fail-closed evidence for `applied`) -> `evolveValidate`. No new automatic promotion channel.
- **Default off:** in v0 `ZELARI_EVOLUTION=0`; `shadow` (observe and propose, do not promote) is explicit opt-in, not default - consistent with the repo's strict defaults (ADR-0025/0027).
- **Scope migrations:** `session -> project -> user` require human confirmation (P3); every promoted artifact carries lineage in frontmatter (genome hash, parent, manifest, `promotedBy`).
- **Deterministic fitness:** pass rate on anchors with tier = tool, cost and latency normalized per task class, `/steer --interrupt` and rollback rate as a P3 proxy. Never LLM-as-judge as the primary source.
- **CI:** `scripts/touches-judge.mjs` lists the judge files touched by a diff; PRs modifying them get the `touches-judge` label and require heightened scrutiny.
- **Dogfooding:** zelari missions on the repo itself produce only PRs with an attached ADR and a sampled audit report (it automates the P1 question of the roadmap in PRINCIPLES.md without removing the human gate); the diff cannot touch the judge paths.

## Consequences

- **Positive:** P1 and P2 stay mechanical even with an active evolutionary engine; anti-Goodhart becomes a CI-verified invariant, not good will; the existing value in `tools/eval/` is capitalized instead of duplicated.
- **Negative:** every genome extension requires an explicit update of this ADR + `JUDGE_PATHS`; deterministic fitness is more expensive to compute than an LLM-as-judge (accepted).
- **Neutral:** `JUDGE_PATHS` is a living list: the check fails if a path disappears, to prevent the list rotting silently.

## Alternatives considered

1. **Auto-promotion with fitness thresholds** - rejected: violates P1/P2 (the proposer would also be the measurer) and creates the gravest Goodhart vector.
2. **Separate greenfield Evolution Engine** - rejected: duplicates propose/decide/validate already present in `tools/eval/`.
3. **Documentation only, no mechanical gate** - rejected: without a CI check the separation would be a prompt promise (P2 forbids exactly that).