---
kind: doc
id: synthesis
date: 2026-07-16
tags: [synthesis, v0.10, grok-build, harness, lucifero]
related: [steal-list-v0-10-acceptance]
---
# Synthesis — Steal selettivo Grok Build → Zelari Code v0.10.0

> Lucifero · design-phase · 2026-07-16  
> Fonti: Caronte (matrice), Gerione (gap/IA), Nettuno (wiring), Plutone (knowledge map UX), Minosse (risks R1–R12).  
> Licenza: **pattern only** (Grok Apache-2.0 → reimpl MIT). Nessun codice Rust, nessun binary `grok`.

---

## Executive summary

**Sì, si può “rubare”** da [grok-build](https://github.com/xai-org/grok-build) — ma **solo pattern/UX/API shape**, non codice. Grok è un harness **single-agent Rust** enterprise (hooks lifecycle, folder-trust, inspect, plugin package, ACP, worktree CoW). Zelari è **TypeScript multi-agent council** + multi-provider + `.zelari/` vault + verification + Desktop.

**Verdetto:** non sostituire Zelari con Grok. Adozione selettiva su **safety gate + osservabilità** dove Grok è maturo; raddoppiare dove Zelari è unico (council, evidence ladder, multi-provider, plan/build phase).

| | Grok Build | Zelari Code |
|---|---|---|
| Stack | Rust monorepo + TUI | TS/Node + Ink TUI + Tauri Desktop |
| Modello | Single-agent | Council 6 ruoli + single-agent |
| Estensibilità | Plugins + marketplace + hooks | Skills + MCP + plugins binary leggeri |
| Sicurezza | Folder-trust, PreToolUse deny | Sandbox, shell blocklist, phase gate — **manca** trust/hooks lifecycle |
| Contesto | Compaction massiccia, codebase-graph | Compaction sliding, checkpoint, semantic_search |
| Differenziatori | ACP, CoW worktree | Council + verification + multi-provider + vault |

**Ship target:** milestone **v0.10.0** = P0 (hooks+trust+inspect) + P0.5 (Desktop mirror + tests + SECURITY) + slice P1 sicura. **P2 fuori da v0.10.**

---

## Decisioni consolidate (conflitti risolti)

| Conflitto | Risoluzione Lucifero |
|---|---|
| Piano doppio Caronte vs Nettuno (R3) | **Un solo plan** con fileRefs Nettuno; fasi gemelle eliminate |
| Fail-open vs “policy deny” enterprise (R4) | Fail-open **v1 default** + chip FAIL-OPEN + opzione futura `strictHooks`; non promettere policy enforcement |
| `/rewind` Grok-like vs checkpoint tree (R7) | Rewind = **transcript only**; checkpoint resta separato |
| Pack “bridge plugins” vs binary optional (R2) | Pack v1 **read-only paths**; no download/marketplace |
| Mode auto (R12) | **Fuori ship v0.10** (stub o post-0.10) |
| ACP / worktree / `/loop` | **P2 backlog**, non bloccano v0.10 |
| Choke-point hooks | **`ToolRegistry.invoke`** (`packages/core/src/core/tools/registry.ts`), non solo `AgentHarness.invokeOne` |
| Ordine gate (R6) | Fisso: **phase → sandbox/blocklist → PreToolUse → execute → PostToolUse** |
| Trust MCP breaking (R5) | Prompt one-shot “Trust this folder?” + kill-switch `ZELARI_FOLDER_TRUST=0` |

---

## Steal list prioritizzata (finale)

### ★ P0 — Ship gate v0.10.0

| # | Feature (da Grok) | Adattamento Zelari | FileRefs chiave |
|---|---|---|---|
| 1 | Lifecycle hooks (`PreToolUse` deny, Post*, Session*) | `LifecycleHookRunner` iniettato; fail-open; deny solo JSON esplicito; timeout 5s | `packages/core/src/core/tools/registry.ts`, `packages/core/src/core/AgentHarness.ts`, nuovo `packages/core/src/core/hooks/*` |
| 2 | Folder trust | `~/.zelari-code/trusted_folders.toml` + gate project hooks/MCP | nuovo `src/cli/safety/folderTrust.ts`, `src/cli/mcp/mcpManager.ts` |
| 3 | `inspect` unificato | Runtime report ≠ `doctor` install; human + `--json` | `src/cli/utils/doctor.ts` (non toccare scope), nuovo `src/cli/commands/inspect.ts`, slash `/inspect` |

**Hard acceptance P0 (Minosse non negoziabile):**

1. Untrusted cwd → **zero spawn** di project hooks; project MCP non caricato.  
2. Ordine gate: phase → blocklist/sandbox → PreToolUse → exec.  
3. Deny esplicito → tool non esegue; crash/timeout hook → allow + audit **FAIL-OPEN** visibile in TUI.  
4. `updatedInput` **disabilitato in v1** (o re-validato post-mutate — preferenza: disabilitato).  
5. `/inspect` sezioni: trust, hooks, mcp, skills, plugins, phase/mode; schema JSON versioned.  
6. SECURITY.md aggiornato (hooks RCE surface, trust, kill-switch).  
7. Test unitari: deny, fail-open, untrusted no-spawn, path canonicalize Windows.

### P0.5 — Desktop + docs + harness test

| # | Feature | Note |
|---|---|---|
| 4 | TrustBadge + X-Ray | Mirror `/inspect` JSON; stesso `trusted_folders.toml` (no store parallelo Tauri) |
| 5 | Docs steal-list + acceptance | Questo doc + SECURITY |
| 6 | Test harness hooks/trust | Vitest core + CLI |

### P1 — Post-P0, ancora in milestone se capacity

| # | Feature | De-risk |
|---|---|---|
| 7 | `/fork` + `/rewind` | Rewind = transcript; copy UX esplicita |
| 8 | `/context` + auto-compact threshold | Allineato `tokenBudget` 70/85 |
| 9 | Capability Pack v1 | Manifesto locale read-only; install esplicito + trust |
| 10 | Compat Claude/Cursor skill/hook paths | Flag opt-in `[compat.*]` |

### P2 — Backlog esplicito (non v0.10)

- ACP adapter stdio  
- git worktree isolation / CoW  
- `/loop` scheduler  
- Plugin marketplace  
- Mode auto permission classifier  
- `updatedInput` mutante  
- Subagent lifecycle hooks  
- HTTP hooks auth  

### Non rubare (confermato)

- Riscrittura codebase-graph Rust  
- Fast worktree btrfs CoW  
- Port tool da Codex/OpenCode  
- Memory flush/dream (overlap lessons)  
- Qualsiasi copy-paste sorgente Apache-2.0  

---

## Stack / arch decisions

```
CLI discovery (hooks/*.json, trusted_folders.toml)
        │
        ▼
LifecycleHookRunner ──iniettato──► ToolRegistry.invoke ──► tool.execute
        │                              ▲
FolderTrustStore ──gate──► project hooks + project MCP
        │
/inspect · /trust · Desktop X-Ray (read-only mirror)
```

- **Transport v1:** `command` (stdin event JSON → stdout decision); HTTP opzionale post-v0.10.  
- **Discovery:** `~/.zelari-code/hooks/` sempre trusted; `<cwd>/.zelari/hooks/` solo se trusted.  
- **Allowlist eseguibili** per hook command (no shell-as-string dove evitabile); timeout 5s.  
- Council e single-agent condividono lo stesso runner via config.

---

## Fasi di implementazione

| Fase | Deliverable | Exit |
|---|---|---|
| **P0** Safety + observability | HookRunner + Trust + `/trust` + `/inspect` | Acceptance hard #1–7 verdi |
| **P0.5** Mirror + quality | Desktop badge/X-Ray + tests + SECURITY | CI tests; X-Ray = inspect |
| **P1** Session + pack | fork/rewind, `/context`, pack v1, compat paths | UX copy chiara; pack read-only |
| **P2** Backlog | ACP, worktree, loop, marketplace | Non blocca release 0.10 |

---

## Top risks (da Minosse, ranked)

1. **R1 RCE hooks** — mitigation: trust gate + no spawn untrusted + allowlist + timeout  
2. **R3 scope/piano doppio** — mitigation: questo plan unificato  
3. **R4 fail-open mascherato** — chip + audit + no claim enterprise policy  
4. **R6 ordering / updatedInput bypass** — ordine fisso; no updatedInput v1  
5. **R2 supply-chain pack** — read-only + install esplicito  
6. **R5 trust Windows / MCP breaking** — canonicalize + trust prompt migrazione  

Dettaglio: [[risks]]

---

## Green-light checklist (design → implement)

- [x] Comparazione pubblicata (`docs/comparazione-harness-grok-build-vs-zelari-code.md`)  
- [x] ADR 001 hooks+trust (proposed)  
- [x] ADR 002 pack, 003 time-travel (proposed, P1)  
- [x] Arch wiring Nettuno su `ToolRegistry.invoke`  
- [x] Knowledge map UX Plutone  
- [x] Risk review Minosse (12 rischi)  
- [x] **Piano unificato** (questo run — createPlan)  
- [x] Steal list + acceptance v0.10 (questo documento)  
- [ ] Implementazione P0 (prossimo run coding)  
- [ ] Nessuna dipendenza runtime da crate/binary Grok  

**Go / no-go implementazione:** **GO** su P0+P0.5 con acceptance hard. **NO-GO** su P2 e mode-auto in v0.10.

---

## Related

- [[comparazione-harness-grok-build-vs-zelari-code]]  
- [[architettura-hooks-su-agentharness-folder-trust]]  
- [[knowledge-map]]  
- [[001-adr-lifecycle-hooks-folder-trust-ispirati-a-grok-build]]  
- [[risks]]  
- [[steal-list-v0-10-acceptance]]  
