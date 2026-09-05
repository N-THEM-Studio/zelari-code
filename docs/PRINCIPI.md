# PRINCIPI.md - First principles of Zelari Code

> **Non-normative mirror.** The canonical document is
> [PRINCIPLES.md](../PRINCIPLES.md) (English): on conflict **the canonical
> one wins**. This mirror is kept for historical continuity.
> Ratified by a governance session on 2026-08-13
> ([ADR-0010](./decisions/0010-first-principles-manifesto.md)).

## Method

A candidate is a *first principle* - not a convention - if it passes three
tests:

1. **Arbitrates tradeoffs** - when two desires conflict, it decides.
2. **Is stable across versions** - 1.0 -> 1.34 did not change it.
3. **Is not derivable** - if it descends from a deeper principle, it is a convention.

## The six principles

### P1 - Verifiability

**Statement.** Every agent assertion is verified or declared unverified; the
product itself submits to the same standard: no non-trivial release ships
without an independent audit
([ADR-0007](./decisions/0007-pre-release-audit-workflow-gate.md)).

**Why it is first.** It is the deepest principle: *do not trust an unverified
assertion - including your own*. It generated the evidence ladder
(claimed->grep->tool->build), the honesty lint on syntheses, the Minosse
review, the literal conformance reviewer. An external audit found 4 runtime
bugs that 759 tests did not see (ADR-0007).

> **P1 invariant - OBSERVATION INTEGRITY** ([ADR-0019](./decisions/0019-observation-integrity-p1-clause.md), v1.46)
> A negative conclusion requires a successful and sufficiently scoped observation.
> EMPTY is evidence. DEGRADED is not evidence. ERROR is not evidence.
> TRUNCATED is partial evidence only.
>
> *Do not trust an unverified assertion* includes **false empties**: an empty
> result from a degraded, badly scoped or backend-less observation is an
> unverified assertion, not proof of absence.

> **P1 invariant - PROPOSER/MEASURER SEPARATION** ([ADR-0036](./decisions/0036-evolution-engine-proposer-judge-separation.md))
> The engine that proposes is not the engine that measures. No artifact can
> promote itself. PASS authority stays with the deterministic gates (anchor
> evals, tier ranking, completion policy); an LLM judgment counts at most as
> tier `claimed` - it can propose, it can never promote.

**How it is guaranteed.** Deterministic mechanisms (`honesty.ts`, tier
ranking, microGate) + process gates (independent audit on non-trivial
releases). *Strong on the deterministic; the rest is mitigated, not
guaranteed.*

**How it is guaranteed (observation integrity).** v1.46 (ADR-0019):
discriminated statuses and sentinels in the observation tools -
`grep_content` (`SEARCH_EMPTY_SCOPE`, `DEPRECATED_INPUT`, `filesWalked`),
ast/LSP (`file-not-found` with the path inspected, `typescript-unavailable`,
`read-error`), `inspect_command` (`degraded` + `artifactsWritten`,
`unsupported_project_shape`) - plus the epistemic rule in the plan/kraken
prompts. EMPTY is never manufactured from DEGRADED.

**How it is guaranteed (proposer/judge separation).** `JUDGE_PATHS` in
`scripts/verify-principles.mjs` (hard in CI): the evolutionary genome cannot
live in, nor be imported from, the judge paths - `ToolRegistry.invoke`,
sandbox/blocklist/trust/permissions, honesty lint and tier ranking, Tier-0
anchors, the eval gate runner, the retention gate and the principles gate
itself (ADR-0036).

### P2 - Deterministic control

**Statement.** Everything governing security, permissions and verification is
deterministic, tested code - never prompt promises. Security promises do not
exceed what the mechanism guarantees.

**Why it is first.** It arbitrates "security vs speed": it chose the single
choke-point (`ToolRegistry.invoke`), the fixed order
phase -> sandbox/blocklist -> PreToolUse -> execute -> PostToolUse, the
declared fail-open (FAIL-OPEN chip), LLM-less language detection.

**How it is guaranteed.** Code-level: sandbox, shell blocklist, folder trust,
lifecycle hooks, phase gate - all at the single choke-point, with dedicated
unit tests. *Strong.*

### P3 - User sovereignty

**Statement.** The user is the authority on **goals** and on **ambiguous
readings** (literal conformance to the prompt); the system governs the
**dangerous means**, with total transparency. The two domains split control:
goals -> user, dangerous means -> system, transparency burden -> system.

**Why it is first.** It arbitrates "the system knows better" vs "the user
decides": persona conformance, `/steer`, permission broker, `/trust`,
confirmations for destructive actions.

**How it is guaranteed.** Hybrid: deterministic gates on dangerous means;
prompts/conformance for goal fidelity; mandatory transparency (actionable
messages, FAIL-OPEN chip).

### P4 - Open, reusable runtime

**Statement.** The whole monorepo is **Apache-2.0**
([ADR-0009](./decisions/0009-apache-2-0-license.md)); `@zelari/core` exposes
a stable public API
([ADR-0004](./decisions/0004-public-api-stability-policy.md)) and is
provider-agnostic. The proprietary value is the **in-session experience**,
not lock-in.

**Why it is first.** It arbitrated "open vs controlled": won against
dual-licensing (ADR-0008) and against internal deep-linking. The secrecy
policy protects the experience (model refusal), it does not claim property
over the code.

**How it is guaranteed.** Publish pipeline (tag==version, OIDC Trusted
Publishing), exports map, API stability tests. *Strong on the mechanical;
the experience is protected only by behavioral policy.*

### P5 - Lightness

**Statement.** Std-lib first in the **runtime core**; heavy dependencies
allowed only in the **interface** (Ink+React TUI, Tauri Desktop), never in
the core. Zero heavy utilities (lodash, immer, ...).

**Why it is first.** It arbitrated "productivity vs simplicity": the core
runs with few auditable dependencies; React lives in the CLI UI, not in the
core - consistent with this formulation.

**How it is guaranteed.** Mechanical gate `scripts/verify-principles.mjs`
(heavy dependency blacklist + core runtime allowlist) run in CI on every PR
(`.github/workflows/ci.yml`).

### P6 - Right-sized orchestration

**Statement.** The multi-agent structure is chosen for the job, not for
identity: kraken (single-agent with tentacles), council (6 roles), zelari
(autonomous missions) are instances of the same principle. No default is
sacred.

**Why it is first.** It resolves the identity tension "council-first vs
kraken-first": the kraken default is a coherent choice, not a violation.

**How it is guaranteed.** Governance: every new mode must justify
cost/latency against the job (e.g. `ZELARI_COUNCIL_TIER=lite`).

## Derivations (conventions, not principles)

They derive from P1+P2+P5; they must be respected, but they are not first:

| Convention | Derives from |
|---|---|
| Zod for all tool args | P2 (deterministic validation) |
| One tool per file in `builtin/` | P1 (reviewability) |
| Modules = ~300 LOC | P1 |
| Atomic single-task commits | P1 |
| Async-first | P5 (no blocking, no useless frameworks) |
| Language policy (user's language) | P3 |
| Declared fail-open + chip | P2 (do not promise enforcement that is not there) |
| Evidence ladder, honesty lint, microGate | P1 |

## Guarantee: what is guaranteed and what is not

| Principle | Current guarantee |
|---|---|
| P2 Deterministic control | **Guaranteed** - code-level, tested |
| P1 Verifiability | **Strong on the deterministic** - the pre-release audit remains a process |
| P4 Open runtime | **Guaranteed on the mechanical** (CI publish) - the experience is policy |
| P3 User sovereignty | **Mitigated** - goal fidelity is prompt, not mechanism |
| P5 Lightness | **Guaranteed** - verify-principles + CI on PRs |
| P6 Right-sized orchestration | **Governance** - decisions, not checks |

## Guarantee roadmap

1. OK `scripts/verify-principles.mjs` - mechanical checks for P5 (blacklist +
   core allowlist), P4 (license), P2 (Zod per tool, choke-point hooks),
   proposer/judge separation (ADR-0036), and the preferences (1 tool/file,
   LOC).
2. OK CI on `pull_request` - `.github/workflows/ci.yml`: typecheck + tests +
   verify-principles as the merge gate.
3. OK P1 on releases - automate the sampling audit ADR-0007-style (planned
   via dogfooding of the evolutionary loop: PR + automatic audit report, the
   human gate stays).

## Decisions of this ratification

1. The identity principle is **"right-sized orchestration for the job"**
   (P6): the kraken default violates no principle.
2. License of the whole product: **MIT -> Apache-2.0** (ADR-0009); secrecy
   policy reformulated as "open runtime, protected experience".
3. **P5 is first** with an explicit exemption for the interface.
4. **P3 with shared domains**: goals to the user, dangerous means to the
   system, mandatory transparency.
5. **P1 confirmed as the root** of the whole principles system.
6. (2026-09-04, ADR-0036) The canonical text is **English**;
   `docs/PRINCIPI.md` is a non-normative mirror.