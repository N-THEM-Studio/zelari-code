# Architecture Decision Records (ADRs)

This directory holds the architectural decisions of Zelari Code.
Every decision is immutable once accepted; changes happen by writing a **new**
ADR that marks the previous one as "Superseded by".

**Numbering rules** (applied by the 2026-09-04 triage):

- A 4-digit number, once assigned, is **never reused**.
- Missing numbers in the sequence (0011, 0012) were **never assigned**: they
  must not be filled in retroactively.
- The draft vault `.zelari/decisions/` uses a **separate series** (3-digit
  ids); promotion into `docs/decisions/` takes the next free canonical
  number.

## Index

Generated from the real file tree (triage t37/S6, 2026-09-04).

| # | Title | Status | Proposed | Notes |
|------|-----------------------------------------------------|--------------|---------------|-------------------|
| 0001 | Monorepo with npm workspaces for `@zelari/core` | ✅ Accepted | 2026-07-01 | retro on commit `6ec90be` |
| 0002 | Publishing `@zelari/core` to npm | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0003 | Versioning scheme for the zelari-code monorepo | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0004 | Public API stability policy for `@zelari/core` | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0005 | Deprecation of legacy source paths | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0006 | Real Lucifero chairman synthesis | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0007 | Independent pre-release audit (agy) as a workflow gate | ✅ Accepted | 2026-07-02 | auto, MiniMax-M3 |
| 0008 | MIT monorepo for the open-source release | ⚠️ Superseded | 2026-07-15 | → ADR-0009 |
| 0009 | Apache-2.0 license for the whole monorepo | ✅ Accepted | 2026-08-13 | |
| 0010 | First-principles manifesto (PRINCIPLES.md, P1–P6) | ✅ Accepted | 2026-08-13 | |
| 0013 | Budget cap (token/USD) as the mission's third stop-rule | ✅ Accepted | 2026-07-20 | implemented |
| 0014 | Event-driven mission triggers | ✅ Accepted | 2026-07-20 | implemented |
| 0015 | Opt-in companion host (`zelari-code serve`) | ✅ Accepted | 2026-07-23 | |
| 0016 | Event-sourced session log as the single source of truth | ✅ Accepted | 2026-08-14 | accepted 2026-08-19 |
| 0017 | Unified "thinking effort" selection across providers | 📝 Proposed — parked | 2026-08-14 | triage 2026-09-04: never implemented; reopen on cost evidence (t31) |
| 0018 | Workspace task store contract on `.zelari/plan.json` (`task_*` tools) | ✅ Accepted | 2026-08-16 | slice 3a implemented (v1.43.0) |
| 0019 | Observation Integrity as an explicit P1 clause | ✅ Accepted | 2026-08-17 | |
| 0020 | Kraken: plan-safe explore task | ✅ Accepted | 2026-08-18 | |
| 0021 | Session spine v1 contract | ✅ Accepted | 2026-08-19 | |
| 0022 | Execution seams (WorkspaceProvider & friends) and versioned profiles | ✅ Accepted | 2026-08-19 | |
| 0023 | Deterministic verification and CompletionPolicy (evidence contract) | ✅ Accepted | 2026-08-19 | |
| 0024 | Closing the dual-write: spine as the only model-context source | ✅ Accepted | 2026-08-19 | amended 2026-08-30 |
| 0025 | Strict-done defaults split by surface (Kraken opt-in, mission ON) | ✅ Accepted | 2026-08-20 | |
| 0026 | RC defaults: event-backed evidence ON, Kraken strict stays opt-in | ✅ Accepted | 2026-08-20 | |
| 0027 | Strict Kraken default 2.1: stays CLI opt-in, host decides via pack | ✅ Accepted | 2026-08-20 | |
| 0028 | Adaptive native criteria pack: CLI explicit, default owned by the host | ✅ Accepted | 2026-08-20 | |
| 0029 | Native-first shared cognitive memory, local SQLite and external MCP | ✅ Accepted | 2026-08-23 | |
| 0030 | HARNESS-10 defaults rationalization: strict-done and verify-pack ON, headless trust UNTRUSTED | ✅ Accepted | 2026-08-23 | |
| 0031 | Recall asymmetry on single-agent paths (W3): deliberate, measurable opt-in | ✅ Accepted | 2026-08-30 | promoted from `.zelari/decisions/014` |
| 0032 | Projection unification: the CLI budget pipeline is the canonical compiler (W4) | ✅ Accepted | 2026-08-30 | promoted from `.zelari/decisions/015` |
| 0033 | Anchored edit: file-level snapshot, exact apply, structured error | ✅ Accepted | 2026-09-02 | implemented (slices t72–t79, releases 2.24–2.26) |
| 0034 | Desktop ships the same contract (guided CLI install first, bundling deferred) | ✅ Accepted | 2026-09-02 | identity wave |
| 0035 | Parallel council fan-out + trace view | ✅ Accepted | 2026-07-20 | Phase B deferred; **renumbered from duplicate "0015"** (triage 2026-09-04) |
| 0036 | Evolution Engine: proposer/judge separation | Accepted | 2026-09-04 | ZELARI_EVOLUTION=0 default; JUDGE_PATHS gate in CI |

Numbers never assigned: **0011, 0012** (free slots, do not fill).

### Legacy (pre-schema numbering, 3 digits)

Historical files predating the 4-digit schema. They are **not** part of the
canonical series: legacy `013` ≠ `ADR-0013` (mission budget cap).

| # | Title | Status | Date |
|------|-----------------------------------------------------|--------------|---------------|
| 012 | Durable State Layer + Prompt Cache Efficiency | accepted | 2026-07-18 |
| 013 | Weakness-based hypothesis selection (Bennett's Razor for Kraken) | accepted | 2026-08-08 |

### Draft vault (`.zelari/decisions/`, separate series)

Design-vault ADRs, not canonical. Vault numbering (3 digits) is independent
from this directory's.

| # | Title | Status | Notes |
|------|-----------------------------------------------------|--------------|-------------------|
| 016 | The TaskContract compiles in the harness (capability layer + criteria) | accepted | amendment to ADR-0023; renumbered from vault "0030" due to the collision with canonical ADR-0030 (triage 2026-09-04) |

## Format

- **Filename:** `NNNN-title-kebab-case.md` (4 digits, zero-padded).
- **Status values:**
  - `Proposed` — written, waiting for Andrea's OK.
  - `Accepted` — implemented or being implemented.
  - `Superseded` — superseded by a later ADR (link there).
  - `Retracted` — accepted then revoked (rare).
- **Structure:** Context → Decision → Alternatives →
  Consequences → TODO.
- **Language:** English (consistent with the rest of zelari-code).

## Process

1. MiniMax (or a contributor) proposes an ADR when they see a non-obvious
   decision that constrains future code.
2. **Default:** ADRs written by MiniMax are **auto-accepted on creation**,
   unless Andrea explicitly objects. This is because proposals already start
   from an analysis of coherence with the existing code. If Andrea disagrees,
   the ADR is:
   - Revised (decision change, append "Rescinded").
   - Superseded by a new ADR that marks the old one as `Superseded`.
3. Accepted ADRs have all TODOs checked off or moved to the issue tracker.
