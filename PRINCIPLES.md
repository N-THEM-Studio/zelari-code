# PRINCIPLES.md — First principles of Zelari Code

> **Canonical manifesto (English).** Ratified by the governance session of
> 2026-08-13 ([ADR-0010](docs/decisions/0010-first-principles-manifesto.md)).
> It supersedes the scattered formulations in `AGENTS.MD`, `CONTRIBUTING.md`
> and `.zelari/docs/`: on conflict **this document wins**.
> The Italian version at [docs/PRINCIPI.md](docs/PRINCIPI.md) is a
> non-normative translation kept for continuity.

## Method

A candidate is a *first principle* — not a convention — if it passes three tests:

1. **It arbitrates tradeoffs** — when two desires conflict, it decides.
2. **It is stable across versions** — 1.0 → 1.34 did not change it.
3. **It is not derivable** — if it descends from a deeper principle, it is a convention.

## The six principles

### P1 · Verifiability

**Statement.** Every agent assertion is either verified or declared unverified; the product itself submits to the same standard: no non-trivial release ships without an independent audit ([ADR-0007](docs/decisions/0007-pre-release-audit-workflow-gate.md)).

**Why it is first.** It is the deepest principle: *do not trust an unverified assertion — including your own*. It generated the evidence ladder (claimed→grep→tool→build), the honesty lint over syntheses, Minosse's review, the literal conformance reviewer. An external audit found 4 runtime bugs that 759 tests did not see (ADR-0007).

> **P1 invariant · OBSERVATION INTEGRITY** ([ADR-0019](docs/decisions/0019-observation-integrity-p1-clause.md), v1.46)
> A negative conclusion requires a successful and sufficiently scoped observation.
> EMPTY is evidence. DEGRADED is not evidence. ERROR is not evidence.
> TRUNCATED is partial evidence only.
>
> *Do not trust an unverified assertion* includes **false empties**: an empty result from a degraded, mis-scoped, or backend-less observation is an unverified assertion, not proof of absence.

> **P1 invariant · PROPOSER/MEASURER SEPARATION** ([ADR-0036](docs/decisions/0036-evolution-engine-proposer-judge-separation.md))
> The engine that proposes is not the engine that measures. No artifact may
> promote itself. PASS authority stays with deterministic gates (eval anchors,
> tier ranking, completion policy); an LLM opinion counts as tier `claimed` at
> most — it can propose, it can never promote.

**How it is guaranteed.** Deterministic mechanisms (`honesty.ts`, tier ranking, microGate) + process gates (independent audit on non-trivial releases). *Strong on the deterministic; the rest is mitigated, not guaranteed.*

**How it is guaranteed (observation integrity).** v1.46 (ADR-0019): discriminated statuses and sentinels in observation tools — `grep_content` (`SEARCH_EMPTY_SCOPE`, `DEPRECATED_INPUT`, `filesWalked`), AST/LSP (`file-not-found` with the path looked at, `typescript-unavailable`, `read-error`), `inspect_command` (`degraded` + `artifactsWritten`, `unsupported_project_shape`) — plus the epistemic rule in plan/kraken prompts. EMPTY is never manufactured from the degraded.

**How it is guaranteed (proposer/measurer separation).** `JUDGE_PATHS` in `scripts/verify-principles.mjs` (CI-hard): the evolution genome may never live in, or be imported by, the judge — `ToolRegistry.invoke`, sandbox/blocklist/trust/permissions, honesty lint and tier ranking, Tier-0 anchors, the eval gate runner, the retention gate, and the principles gate itself (ADR-0036).

### P2 · Deterministic control

**Statement.** Everything governing security, permissions and verification is deterministic, tested code — never prompt promises. Security promises never exceed what the mechanism guarantees.

**Why it is first.** It arbitrates "security vs speed": it chose the single choke-point (`ToolRegistry.invoke`), the fixed order phase → sandbox/blocklist → PreToolUse → execute → PostToolUse, the declared fail-open (FAIL-OPEN chip), LLM-free language detection.

**How it is guaranteed.** Code-level: sandbox, shell blocklist, folder trust, lifecycle hooks, phase gate — all at the single choke-point, with dedicated unit tests. *Strong.*

### P3 · User sovereignty

**Statement.** The user is the authority on **goals** and on **ambiguous readings** (literal conformance to the prompt); the system governs the **dangerous means**, with total transparency. The two domains split control: goals → user, dangerous means → system, burden of transparency → system.

**Why it is first.** It arbitrates "the system knows better" vs "the user decides": conformance persona, `/steer`, permission broker, `/trust`, confirmations for destructive actions.

**How it is guaranteed.** Mixed: deterministic gates on dangerous means; prompt/conformance for goal fidelity; mandatory transparency (actionable messages, FAIL-OPEN chips).

### P4 · Open, reusable runtime

**Statement.** The whole monorepo is **Apache-2.0** ([ADR-0009](docs/decisions/0009-apache-2-0-license.md)); `@zelari/core` exposes a stable public API ([ADR-0004](docs/decisions/0004-public-api-stability-policy.md)) and is provider-agnostic. The proprietary value is the **in-session experience**, not lock-in.

**Why it is first.** It arbitrated "open vs controlled": won against dual-licensing (ADR-0008) and against internal deep-linking. The secrecy policy protects the experience (model refusal), it does not claim ownership of code.

**How it is guaranteed.** Publish pipeline (tag==version, OIDC Trusted Publishing), exports map, API stability tests. *Strong on the mechanical; the experience is protected only by behavioral policy.*

### P5 · Lightness

**Statement.** Std-lib first in the **runtime core**; heavy dependencies allowed only in the **interface** (Ink+React TUI, Tauri Desktop), never in the core. Zero heavy utilities (lodash, immer, …).

**Why it is first.** It arbitrated "productivity vs simplicity": the core runs with few auditable dependencies; React lives in the CLI UI, not in the core — consistent with this formulation.

**How it is guaranteed.** Mechanical gate `scripts/verify-principles.mjs` (heavy-dep blacklist + core runtime allowlist) run in CI on every PR (`.github/workflows/ci.yml`).

### P6 · Right-sized orchestration

**Statement.** The multi-agent structure is chosen for the work, not for identity: kraken (single-agent with tentacles), council (6 roles), zelari (autonomous missions) are instances of the same principle. No default is sacred.

**Why it is first.** It resolved the identity tension "council-first vs kraken-first": the kraken default is a coherent choice, not a violation.

**How it is guaranteed.** Governance: every new mode must justify cost/latency against the work (e.g. `ZELARI_COUNCIL_TIER=lite`).

## Derivations (conventions, not principles)

They derive from P1+P2+P5; they must be respected, but they are not first:

| Convention | Derives from |
|---|---|
| Zod for all tool args | P2 (deterministic validation) |
| One tool per file in `builtin/` | P1 (reviewability) |
| Modules ≤ ~300 LOC | P1 |
| Atomic single-task commits | P1 |
| Async-first | P5 (no blocking, no needless frameworks) |
| Language policy (user's language) | P3 |
| Declared fail-open + chip | P2 (don't promise enforcement you don't have) |
| Evidence ladder, honesty lint, microGate | P1 |

## Guarantees: what is guaranteed and what is not

| Principle | Current guarantee |
|---|---|
| P2 Deterministic control | **Guaranteed** — code-level, tested |
| P1 Verifiability | **Strong on the deterministic** — pre-release audit remains process |
| P4 Open runtime | **Guaranteed on the mechanical** (CI publish) — experience is policy |
| P3 User sovereignty | **Mitigated** — goal fidelity is prompt, not mechanism |
| P5 Lightness | **Guaranteed** — verify-principles + CI on PRs |
| P6 Right-sized orchestration | **Governance** — decisions, not checks |

## Guarantee roadmap

1. ✅ `scripts/verify-principles.mjs` — mechanical checks for P5 (blacklist + core allowlist), P4 (license), P2 (Zod per tool, hooks choke-point), proposer/judge separation (ADR-0036), and the preferences (1 tool/file, LOC).
2. ✅ CI on `pull_request` — `.github/workflows/ci.yml`: typecheck + test + verify-principles as merge gate.
3. ⬜ P1 on releases — automate the ADR-0007-style sampled audit (planned via the evolution dogfooding loop: PR + automatic audit report, human gate stays).

## Decisions of this ratification

1. The identity principle is **"right-sized orchestration for the work"** (P6): the kraken default violates no principle.
2. License of the whole product: **MIT → Apache-2.0** (ADR-0009); secrecy policy reformulated as "open runtime, protected experience".
3. **P5 is first** with an explicit exemption for the interface.
4. **P3 as shared domains**: goals to the user, dangerous means to the system, mandatory transparency.
5. **P1 confirmed as the root** of the whole principle system.
6. (2026-09-04, ADR-0036) The canonical text is **English**; `docs/PRINCIPI.md` is a non-normative Italian translation.
