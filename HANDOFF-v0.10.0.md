> **SUPERSEDED** - historical snapshot; current state lives in README.md, CHANGELOG.md and docs/decisions/. Not onboarding docs.

> **?? Historical / superseded.** The v0.10.0 "Steal Grok Build" P0 (lifecycle hooks, folder trust `/trust`, unified `--inspect`) shipped in **1.32.0**. Current line is **1.34.0**. See [CHANGELOG.md](./CHANGELOG.md).

---
kind: doc
id: handoff-v0-10-0
date: 2026-07-16
tags: [handoff, v0.10, council, lucifero]
related: [HANDOFF, plan-canonical-v0-10, synthesis, risks]
---
# Zelari Code - Handoff v0.10.0 (2026-07-16, post-Phase A+B)

> Operational handoff for the next v0.10.0 implementation run ("Steal Grok Build").
> State reconciled after Plan normalization (Phase A) + HANDOFF gap closure (Phase B).
> Author: Lucifero (Final Synthesizer) - 2026-07-16.

## TL;DR

The canonical v0.10.0 plan exists and has been **certified 1:1** against `plan.json` (12 ship-path tasks present, 5 anomalies + 1 DEPRECATE marker closed, 0 semantic drift on the active tasks). The historical HANDOFF gaps have been closed:

- ? **B2**: `risks-md.md` cleanup = verified NO-OP (file absent)
- ? **B3**: `.github/dependabot.yml` created (4 ecosystems: npm root/core/desktop, cargo Tauri, github-actions)
- ? **B4**: this file created as `HANDOFF-v0.10.0.md` (does NOT edit the SUPERSEDED `HANDOFF.md`)
- ? **B5**: design-phase docs already aligned (Gerione confirms)
- ?? **B1**: drift-check in `postCouncilHook.ts` not yet implemented (residual gap, R11 mitigation pending)
- ?? **G2**: mission `m_fd0f70ad` to archive (in progress in this run)

**Lucifero verdict**: the plan is ship-ready for the P0+P0.5 implementation phase. P2 and mode-auto stay out of scope (confirmed descope). A valid mission prompt required before the next run.

---

## 1. `zelari-code` repository state

- **Branch**: `main`
- **Last known commit**: `3aaa45d` (v0.7.8 Option B, see the SUPERSEDED `HANDOFF.md`)
- **Package version**: `1.14.4` (CHANGELOG.md, root)
- **Stack**: Node >= 20, TypeScript ~5.7, partial monorepo (`packages/core` workspace), Tauri Desktop (Rust shell + Ink TUI)
- **Tests**: 919/919 GREEN (post-Option B v0.7.8)

## 2. Canonical v0.10.0 plan

**Reference doc**: [`.zelari/docs/plan-canonical-v0-10.md`](./.zelari/docs/plan-canonical-v0-10.md)

| Phase | Ship-path tasks | Status |
|---|---|---|
| **P0** `p0-safety-gate-observability` | 1. LifecycleHookRunner + wire into `ToolRegistry.invoke` (critical) <br/> 2. FolderTrustStore + hooks/MCP gate + `/trust` (critical) <br/> 3. Unified `--inspect`/slash `/inspect` (? `doctor`) (high) | all `pending` |
| **P0.5** `p0-5-desktop-mirror-quality-gate` | 1. Desktop TrustBadge + X-Ray mirror inspect (medium) <br/> 2. SECURITY.md + hooks/trust test harness (high) | all `pending` |
| **P1** `p1-session-ux-extensibility` (not blocked) | 1. `/fork` and `/rewind` slashes on JSONL + branchManager (high) <br/> 2. `/context` radar + compact thresholds 70/85 (high) <br/> 3. Capability Pack v1 read-only + Claude/Cursor path compat (medium) | all `pending` |
| **P2** `p2-backlog-non-blocca-v0-10` | 1. ACP stdio adapter spike (low, backlog) <br/> 2. Git worktree isolation spike (low, backlog) <br/> 3. Headless `/loop` scheduler spike (low, backlog) | all `pending` |

**Explicit v0.10.0 descope** (Lucifero synthesis.md):
- Mode auto permission classifier (out of ship)
- Mutating `updatedInput`
- Marketplace, HTTP auth hooks, Subagent*
- ACP/worktree/loop as release features
- Deterministic replay (was in `p0-5-ship-milestone-v0-10-0-.-replay-.-2`, now `blocked`)

## 3. Plan state changes - Phase A (2026-07-16)

Operations performed via `updateTask`:

| # | Task ID | Action | Reason |
|---|---|---|---|
| 1 | `implementazione-p0-lifecyclehookrunner-wire-lifecyclehookrunner-in-toolregistry-invoke-1` | -> `blocked` | Semantic duplicate of canonical P0.1 |
| 2 | `p0-5-ship-milestone-v0-10-0-replay-deterministico-mode-2` | -> `blocked` | Explicit Lucifero descope |
| 3 | `p1-session-ux-extensibility-permission-mode-auto-compat-skill-paths-4` | -> `blocked` (idempotent, already blocked) | Mode auto out of v0.10 scope |
| 4 | `normalizzazione-piano-v0-10-cleanup-risks-md-md-ridondante-3` | -> `blocked` | Verified NO-OP (`risks-md.md` absent) |
| 5 | `normalizzazione-piano-v0-10-deprecate-fase-milestone-holder-placeholder-order-99-4` (new) | -> `blocked` (marker) | `updateTask` does not accept phase IDs, documentary marker |

**Technical note**: `milestone-holder` (phase order 99, placeholder) is a **phase**, not a task. The `updateTask` API rejects phase IDs. Structural removal is delegated to a `createPlan` cleanup in a later run.

## 4. HANDOFF gaps

### 4.1 Resolved (Phase B)

| # | Gap | Status | Notes |
|---|---|---|---|
| B2 | Redundant `risks-md.md` cleanup | ? Verified NO-OP | File absent from `.zelari/` and `docs/` |
| B3 | Missing Dependabot config | ? Created `.github/dependabot.yml` | 4 ecosystems, limited scope, minor/patch groups |
| B4 | HANDOFF.md SUPERSEDED -> new file needed | ? Created this `HANDOFF-v0.10.0.md` | Does not edit the old one |
| B5 | Design-phase docs sanity check | ? Confirmed (Gerione) | `customer-journey-map`, `information-architecture`, `design-tokens` aligned |

### 4.2 Open (residual)

| # | Gap | Suggested owner | Mitigation |
|---|---|---|---|
| B1 | Missing drift-check in `postCouncilHook.ts` | Nettuno (Phase `chiusura-gap-handoff-post-processor`) | `assertPlanMatchesCanonical(planPath, canonicalPath)` function with cardinality/ID/slug validation (see R11 mitigation) |
| G2 | Mission `m_fd0f70ad` with prompt `"x"` running | Lucifero (in progress in this run) | Change `status: archived`, descriptive prompt |
| G3 | 3 milestones on the same `targetVersion: v0.10.0` | Nettuno (next run) | Keep only `m-v0-10-0-steal-grok-build-shipped` (it has `dueDate: 2026-07-31`) |
| G4 | Triage of the existing 1c+1h+3m Dependabot alerts | Operations | `gh api /repos/N-THEM-Studio/zelari-code/dependabot/alerts` after the config merge |

## 5. Active risks (post-R1 correction)

**Reference doc**: [`.zelari/risks.md`](./.zelari/risks.md)

- **R1** (REJECTED): valid JSON accepted, the "missing `{`" claim was false
- **R1-bis** (new): semantic drift plan-canonical <-> plan.json - partially closed (5 tasks + 1 marker blocked)
- **R2**: diverging plan and milestones - partially closed, 3 residual milestones on the same target
- **R3**: placeholder mission `running` - being closed (this run)
- **R4**: arbitrary execution via lifecycle hooks - Critical, P0 governance
- **R5**: unresolved dependency vulnerabilities - triage depends on Dependabot (now possible with B3)
- **R6**: `councilApi.ts` hotspot at 1138 LOC - refactor pending (<=300 LOC convention)
- **R7**: cumulative hook latency - Medium-High
- **R8**: trust state communicated only visually - accessibility
- **R9**: replay logs and audits may expose sensitive data - privacy
- **R10**: scope creep during exploration - Medium, mitigated by this run
- **R11** (new): missing drift-check in the post-council hook - Medium, mitigation pending

## 6. Next implementation run (gate)

### 6.1 Pre-flight (mandatory)

- [ ] Valid mission prompt (not `"x"`, not a placeholder, >= 1 concrete task)
- [ ] `mission-state.json` updated to `status: archived` for `m_fd0f70ad` (Phase B G2)
- [ ] `plan.json` has 1 P0 + 1 P0.5 + 1 P1 (non-blocked) + 1 P2 backlog without duplicate `pending` ? (verified)
- [ ] `risks.md` with corrected evidence ? (R1 fixed, R1-bis + R11 added, gate updated)
- [ ] `.github/dependabot.yml` present ? (Phase B)

### 6.2 Recommended sequence

1. **Wire LifecycleHookRunner** (`p0-safety-gate-observability-.-wire-toolregistry-invoke-1`)
   - File: `packages/core/src/core/tools/registry.ts` (canonical choke-point)
   - Fail-open, 5s timeout, argv allowlist, no shell-string
   - Unit tests: deny, fail-open, untrusted no-spawn, Windows path canonicalization
2. **FolderTrustStore** (`.-foldertruststore-gate-project-hooks-mcp-trust-2`)
   - Files: `src/cli/safety/folderTrust.ts` + `src/cli/mcp/mcpManager.ts`
   - One-shot "Trust this folder?" prompt + `ZELARI_FOLDER_TRUST=0` kill switch
3. **Unified `/inspect`** (`.-comando-e-slash-inspect-unificato-doctor-3`)
   - Files: new `src/cli/commands/inspect.ts` + `/inspect` slash
   - Sections: trust, hooks, mcp, skills, plugins, phase/mode; versioned JSON schema
4. **SECURITY.md + test harness** (`p0-5-desktop-mirror-quality-gate-.-security-md-.-2`)
   - Files: `SECURITY.md` (root), `tests/unit/hooks-trust.test.ts`
5. **CHANGELOG v0.10.0** (root) + git tag

### 6.3 Out of scope for v0.10.0

All `blocked` tasks (see section 2 P2 descope + section 4.1 Resolved). They stay in the plan for audit/history - do not implement.

## 7. Canonical references

- `.zelari/docs/plan-canonical-v0-10.md` - 12-task ship-path plan
- `.zelari/docs/synthesis.md` - Lucifero verdict, steal list, decisions
- `.zelari/docs/steal-list-v0-10-acceptance.md` - hard P0 acceptance
- `.zelari/risks.md` - evidence-first risk register (R1-R11)
- `.zelari/decisions/001-adr-lifecycle-hooks-folder-trust-ispirati-a-grok-build.md` - ADR 001
- `.zelari/decisions/004-adr-cut-list-v0-10-descope-p2-e-mode-auto.md` - cut list
- `CHANGELOG.md` (root) - published versions (up to 1.14.4)
- `HANDOFF.md` (root, SUPERSEDED) - Option B v0.7.8, history

## 8. History

- **2026-07-03**: Option B HANDOFF pushed to main (commit `3aaa45d`), 919/919 tests GREEN
- **2026-07-16**: Council design-phase run v0.10.0 -> Lucifero synthesis, plan-canonical issued
- **2026-07-16 (this run)**: Phase A plan normalization + Phase B HANDOFF gaps closed
- **Next**: P0+P0.5 implementation run with a valid mission prompt