---
kind: doc
id: handoff-v0-10-0
date: 2026-07-16
tags: [handoff, v0.10, council, lucifero]
related: [HANDOFF, plan-canonical-v0-10, synthesis, risks]
---
# Zelari Code — Handoff v0.10.0 (2026-07-16, post-Fase A+B)

> Handoff operativo per il prossimo implementation run v0.10.0 ("Steal Grok Build").
> Stato riconciliato dopo Normalizzazione piano (Fase A) + Chiusura gap HANDOFF (Fase B).
> Autore: Lucifero (Final Synthesizer) · 2026-07-16.

## TL;DR

Il piano canonico v0.10.0 esiste ed è **stato certificato 1:1** con `plan.json` (12 task ship-path presenti, 5 anomalie + 1 DEPRECATE marker chiusi, 0 drift semantico sui task attivi). I gap HANDOFF storici sono stati chiusi:

- ✅ **B2**: `risks-md.md` cleanup = NO-OP verificato (file assente)
- ✅ **B3**: `.github/dependabot.yml` creato (4 ecosistemi: npm root/core/desktop, cargo Tauri, github-actions)
- ✅ **B4**: questo file creato come `HANDOFF-v0.10.0.md` (NON edita il SUPERSEDED `HANDOFF.md`)
- ✅ **B5**: design-phase docs già allineati (Gerione conferma)
- 🔄 **B1**: drift-check in `postCouncilHook.ts` non ancora implementato (gap residuo, R11 mitigation pending)
- 🔄 **G2**: missione `m_fd0f70ad` da archiviare (in corso in questo run)

**Verdetto Lucifero**: il piano è ship-ready per la fase P0+P0.5 implementation. P2 e mode-auto restano fuori scope (descope confermato). Mission prompt valido richiesto prima del prossimo run.

---

## 1. Stato del repository `zelari-code`

- **Branch**: `main`
- **Ultimo commit noto**: `3aaa45d` (v0.7.8 Opzione B, vedi `HANDOFF.md` SUPERSEDED)
- **Versione package**: `1.14.4` (CHANGELOG.md, root)
- **Stack**: Node ≥ 20, TypeScript ~5.7, monorepo parziale (`packages/core` workspace), Desktop Tauri (Rust shell + Ink TUI)
- **Test**: 919/919 GREEN (post-Opzione B v0.7.8)

## 2. Piano canonico v0.10.0

**Doc di riferimento**: [`.zelari/docs/plan-canonical-v0-10.md`](./.zelari/docs/plan-canonical-v0-10.md)

| Fase | Task ship-path | Status |
|---|---|---|
| **P0** `p0-safety-gate-observability` | 1. LifecycleHookRunner + wire `ToolRegistry.invoke` (critical) <br/> 2. FolderTrustStore + gate hooks/MCP + `/trust` (critical) <br/> 3. Comando e slash `/inspect` unificato (≠ `doctor`) (high) | tutti `pending` |
| **P0.5** `p0-5-desktop-mirror-quality-gate` | 1. Desktop TrustBadge + X-Ray mirror inspect (medium) <br/> 2. SECURITY.md + test harness hooks/trust (high) | tutti `pending` |
| **P1** `p1-session-ux-extensibility` (non blocked) | 1. Slash `/fork` e `/rewind` su JSONL + branchManager (high) <br/> 2. `/context` radar + soglie compact 70/85 (high) <br/> 3. Capability Pack v1 read-only + compat Claude/Cursor paths (medium) | tutti `pending` |
| **P2** `p2-backlog-non-blocca-v0-10` | 1. Spike ACP adapter stdio (low, backlog) <br/> 2. Spike git worktree isolation (low, backlog) <br/> 3. Spike `/loop` scheduler headless (low, backlog) | tutti `pending` |

**Descope esplicito v0.10.0** (Lucifero synthesis.md):
- Mode auto permission classifier (fuori ship)
- `updatedInput` mutante
- Marketplace, HTTP auth hooks, Subagent*
- ACP/worktree/loop come feature release
- Replay deterministico (era in `p0-5-ship-milestone-v0-10-0-…-replay-…-2`, ora `blocked`)

## 3. Cambiamento stato piano — Fase A (2026-07-16)

Operazioni eseguite via `updateTask`:

| # | Task ID | Azione | Motivo |
|---|---|---|---|
| 1 | `implementazione-p0-lifecyclehookrunner-wire-lifecyclehookrunner-in-toolregistry-invoke-1` | → `blocked` | Doppione semantico di canonical P0.1 |
| 2 | `p0-5-ship-milestone-v0-10-0-replay-deterministico-mode-2` | → `blocked` | Descope esplicito Lucifero |
| 3 | `p1-session-ux-extensibility-permission-mode-auto-compat-skill-paths-4` | → `blocked` (idempotente, già blocked) | Mode auto fuori scope v0.10 |
| 4 | `normalizzazione-piano-v0-10-cleanup-risks-md-md-ridondante-3` | → `blocked` | NO-OP verificato (`risks-md.md` assente) |
| 5 | `normalizzazione-piano-v0-10-deprecate-fase-milestone-holder-placeholder-order-99-4` (nuovo) | → `blocked` (marker) | `updateTask` non accetta phase ID, marker documentale |

**Nota tecnica**: `milestone-holder` (phase order 99, placeholder) è una **fase**, non un task. L'API `updateTask` rifiuta phase ID. La rimozione strutturale è demandata a `createPlan` cleanup in run successivo.

## 4. Gap HANDOFF

### 4.1 Risolti (Fase B)

| # | Gap | Stato | Note |
|---|---|---|---|
| B2 | Cleanup `risks-md.md` ridondante | ✅ NO-OP verificato | File assente in `.zelari/` e `docs/` |
| B3 | Dependabot config assente | ✅ Creato `.github/dependabot.yml` | 4 ecosistemi, scope limitato, gruppi minor/patch |
| B4 | HANDOFF.md SUPERSEDED → serve nuovo file | ✅ Creato questo `HANDOFF-v0.10.0.md` | NON edita il vecchio |
| B5 | Sanity check design-phase docs | ✅ Confermato (Gerione) | `customer-journey-map`, `information-architecture`, `design-tokens` allineati |

### 4.2 Aperti (residuo)

| # | Gap | Owner suggerito | Mitigation |
|---|---|---|---|
| B1 | Drift-check assente in `postCouncilHook.ts` | Nettuno (Fase `chiusura-gap-handoff-post-processor`) | Funzione `assertPlanMatchesCanonical(planPath, canonicalPath)` con validazione cardinalità/ID/slug (vedi R11 mitigation) |
| G2 | Missione `m_fd0f70ad` con prompt `"x"` running | Lucifero (in corso in questo run) | Cambiare `status: archived`, prompt descrittivo |
| G3 | 3 milestone su stesso `targetVersion: v0.10.0` | Nettuno (run successivo) | Tenere solo `m-v0-10-0-steal-grok-build-shipped` (ha `dueDate: 2026-07-31`) |
| G4 | Triage Dependabot 1c+1h+3m esistenti | Operazioni | `gh api /repos/N-THEM-Studio/zelari-code/dependabot/alerts` dopo merge config |

## 5. Rischi attivi (post-correzione R1)

**Doc di riferimento**: [`.zelari/risks.md`](./.zelari/risks.md)

- **R1** (RIGETTATO): JSON valido accettato, claim "manca `{`" era falso
- **R1-bis** (nuovo): drift semantico plan-canonical ↔ plan.json — parzialmente chiuso (5 task + 1 marker blocked)
- **R2**: Piano e milestone divergenti — parzialmente chiuso, 3 milestone residue su stesso target
- **R3**: Missione placeholder `running` — in chiusura (questo run)
- **R4**: Esecuzione arbitraria tramite lifecycle hooks — Critical, governance P0
- **R5**: Vulnerabilità dipendenze non chiuse — triage dipende da Dependabot (ora possibile con B3)
- **R6**: Hotspot `councilApi.ts` 1138 LOC — refactor pending (≤300 LOC convenzione)
- **R7**: Latenza cumulativa hook — Medium-High
- **R8**: Stato trust comunicato solo visivamente — accessibilità
- **R9**: Replay log e audit possono esporre dati sensibili — privacy
- **R10**: Scope creep durante esplorazione — Medium, mitigato da questo run
- **R11** (nuovo): Drift-check assente in post-council-hook — Medium, mitigation pending

## 6. Prossimo implementation run (gate)

### 6.1 Pre-flight (obbligatorio)

- [ ] Mission prompt valido (non `"x"`, non placeholder, ≥1 task concreto)
- [ ] `mission-state.json` aggiornato a `status: archived` per `m_fd0f70ad` (Fase B G2)
- [ ] `plan.json` ha 1 P0 + 1 P0.5 + 1 P1 (non-blocked) + 1 P2 backlog senza duplicati `pending` ✅ (verificato)
- [ ] `risks.md` con evidenza corretta ✅ (R1 corretto, R1-bis + R11 aggiunti, gate aggiornato)
- [ ] `.github/dependabot.yml` presente ✅ (Fase B)

### 6.2 Sequenza raccomandata

1. **Wire LifecycleHookRunner** (`p0-safety-gate-observability-…-wire-toolregistry-invoke-1`)
   - File: `packages/core/src/core/tools/registry.ts` (choke-point canonico)
   - Fail-open, timeout 5s, allowlist argv, no shell-string
   - Test unitari: deny, fail-open, untrusted no-spawn, path canonicalize Windows
2. **FolderTrustStore** (`…-foldertruststore-gate-project-hooks-mcp-trust-2`)
   - File: `src/cli/safety/folderTrust.ts` + `src/cli/mcp/mcpManager.ts`
   - Prompt one-shot "Trust this folder?" + kill-switch `ZELARI_FOLDER_TRUST=0`
3. **`/inspect` unificato** (`…-comando-e-slash-inspect-unificato-doctor-3`)
   - File: nuovo `src/cli/commands/inspect.ts` + slash `/inspect`
   - Sezioni: trust, hooks, mcp, skills, plugins, phase/mode; schema JSON versioned
4. **SECURITY.md + test harness** (`p0-5-desktop-mirror-quality-gate-…-security-md-…-2`)
   - File: `SECURITY.md` (root), `tests/unit/hooks-trust.test.ts`
5. **CHANGELOG v0.10.0** (root) + tag git

### 6.3 Fuori scope v0.10.0

Tutti i task `blocked` (vedi §2 P2 descope + §4.1 Risolti). Restano in piano per audit/history, non implementare.

## 7. Riferimenti canonici

- `.zelari/docs/plan-canonical-v0-10.md` — piano ship-path 12 task
- `.zelari/docs/synthesis.md` — verdetto Lucifero, steal list, decisioni
- `.zelari/docs/steal-list-v0-10-acceptance.md` — acceptance hard P0
- `.zelari/risks.md` — registro rischi evidence-first (R1-R11)
- `.zelari/decisions/001-adr-lifecycle-hooks-folder-trust-ispirati-a-grok-build.md` — ADR 001
- `.zelari/decisions/004-adr-cut-list-v0-10-descope-p2-e-mode-auto.md` — cut list
- `CHANGELOG.md` (root) — versioni pubblicate (fino a 1.14.4)
- `HANDOFF.md` (root, SUPERSEDED) — Opzione B v0.7.8, history

## 8. Storia

- **2026-07-03**: HANDOFF Opzione B pushata su main (commit `3aaa45d`), 919/919 test GREEN
- **2026-07-16**: Council design-phase run v0.10.0 → Lucifero synthesis, plan-canonical emesso
- **2026-07-16 (questo run)**: Fase A normalizzazione piano + Fase B gap HANDOFF chiusi
- **Prossimo**: implementation run P0+P0.5 con mission prompt valido
