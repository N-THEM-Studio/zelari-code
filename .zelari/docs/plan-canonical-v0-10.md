---
kind: doc
id: plan-canonical-v0-10
date: 2026-07-16
tags: [plan, v0.10, canonical, lucifero]
---
# Piano canonico v0.10.0 — unificazione task

> Lucifero · 2026-07-16 · risolve R3 (piano doppio Caronte+Nettuno)
> Aggiornato dopo la normalizzazione di `.zelari/plan.json` (6 fasi / 18 task / 1 milestone canonica). Verificato da `planDriftCheck` (postCouncilHook Step 2b).

## Regola

**Implementare solo** i task delle fasi `p0-safety-observability`, `p0-5-desktop-mirror-quality-gate`, `p1-session-ux-extensibility`, `p1-5-governance`, `release-v0-10-0` e spike `p2-backlog-non-blocca-v0-10`.  
Tutti i task con id che iniziano per `p0-parit-*`, `p0-safety-gate-observability-*`, `p0-hook-lifecycle-folder-trust-inspect-*`, `p1-session-ux-estensibilit-*`, `p2-integrazione-*`, `p2-editor-isolation-*`, `p0-5-desktop-mirror-docs-*` sono **blocked** come duplicati o descope.

## Task attivi (ship path)

### P0 — `p0-safety-observability`
1. `p0-safety-observability-lifecyclehookrunner-toolregistry-invoke-1` — critical  
2. `p0-safety-observability-foldertruststore-gate-mcp-hooks-trust-2` — critical  
3. `p0-safety-observability-inspect-unificato-json-versionato-3` — high  

### P0.5 — `p0-5-desktop-mirror-quality-gate`
1. `p0-5-desktop-mirror-quality-gate-trustbadge-xray-ipc-bridge-1` — medium  
2. `p0-5-desktop-mirror-quality-gate-docs-v0-10-steal-list-2` — high (done)  
3. `p0-5-desktop-mirror-quality-gate-security-md-test-harness-3` — high  

### P1 — `p1-session-ux-extensibility`
1. `p1-session-ux-extensibility-branch-manager-fork-rewind-1` — high  
2. `p1-session-ux-extensibility-context-radar-70-85-2` — high  
3. `p1-session-ux-extensibility-failover-claude-composer-2-5-3` — high  
4. `p1-session-ux-extensibility-capability-pack-v1-alias-4` — medium  

### P1.5 — `p1-5-governance`
1. `p1-5-governance-drift-check-postcouncilhook-1` — high  
2. `p1-5-governance-consolidamento-milestone-piano-2` — high (done)  

### Release — `release-v0-10-0`
1. `release-v0-10-0-fix-3-test-rossi-1` — critical  
2. `release-v0-10-0-pulizie-pre-ship-councilapi-replay-2` — medium  
3. `release-v0-10-0-changelog-handoff-bump-tag-3` — critical  

### P2 — backlog only (`p2-backlog-non-blocca-v0-10`)
1. spike ACP  
2. spike worktree  
3. spike /loop  

## Descope esplicito (non ship)
- Mode auto permission classifier  
- `updatedInput` mutante  
- Marketplace, HTTP auth hooks, Subagent*  
- ACP/worktree/loop come feature release  

## Milestone
- Target: **v0.10.0**  
- Nome: Harness parity selettiva con Grok Build (pattern only)  

## Related
- synthesis  
- steal-list-v0-10-acceptance  
- risks  
