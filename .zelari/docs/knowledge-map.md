---
kind: doc
id: knowledge-map
date: 2026-07-16
tags: [knowledge-map, ux, slash, desktop, v0.10, grok-build]
---
# Knowledge Map — Steal da Grok Build → Zelari v0.10

> Plutone · design-phase · pattern only (Apache-2.0 → MIT reimpl)  
> Build-on: Caronte comparazione · Gerione IA/journey/tokens · Nettuno wiring hooks

```
                    ┌─────────────────────────────────────┐
                    │  Zelari Harness v0.10 (steal list)   │
                    │  multi-agent TS + council + Desktop  │
                    └──────────────────┬──────────────────┘
           ┌───────────────┬───────────┼───────────┬───────────────┐
           ▼               ▼           ▼           ▼               ▼
     Safety Gate    Observability   Session UX  Extensibility   Desktop
```

## 1. Safety Gate (P0) ★
| Nodo | Dipende da | Azione |
|---|---|---|
| **LifecycleHookRunner** | `ToolRegistry.invoke` choke-point | PreToolUse deny esplicito; fail-open crash |
| **FolderTrustStore** | `~/.zelari-code/trusted_folders.toml` | Gate project hooks + MCP |
| **`/trust`** | TrustStore | `list \| add \| remove`; modal first-open |
| **Mode auto** (P1) | Permission classifier | Safe-tools allow; overlay su plan/build |
| **Kill-switch** | `ZELARI_FOLDER_TRUST=0` | Dev bypass; badge untrusted resta |

**Links:** HookRunner *depends-on* TrustStore · Project hooks *blocked-by* untrusted · Deny *part-of* PreToolUse

## 2. Observability (P0–P1) ★
| Nodo | Dipende da | Azione |
|---|---|---|
| **`/inspect`** | runtime config (≠ doctor) | Sezioni: hooks, mcp, skills, plugins, rules, trust |
| **`inspect --json`** | stesso report | CI / machine-stable schema |
| **`/context`** | `tokenBudget` 70/85 | Radar system/tools/skills/free |
| **HookDecisionChip** | runner audit | DENY / FAIL-OPEN in TUI (prefisso testuale) |

**Links:** inspect *complements* doctor · `/context` *reads* tokenBudget · X-Ray *mirrors* inspect

## 3. Session UX (P1)
| Nodo | Dipende da | Azione |
|---|---|---|
| **`/fork`** | `branchManager` + JSONL | Alias UX session branch |
| **`/rewind`** | transcript cursor | Default = history only; checkpoint opt-in |
| **Checkpoint** (già) | `checkpointManager` | Non confondere con rewind |
| **`/compact` + hooks** | Pre/PostCompact | Estende sliding-window esistente |

**Links:** fork *part-of* branchManager · rewind *≠* rollback tree · fork *blocks* silent history rewrite

## 4. Extensibility (P1)
| Nodo | Dipende da | Azione |
|---|---|---|
| **CapabilityPack v1** | manifesto JSON | skills + slash + hooks + MCP hints (read-only install) |
| **Binary plugins** (già) | `plugins/registry` | Bridge → pack, non replace |
| **Compat Claude/Cursor** | flag settings | Import hooks opzionale |

**Links:** Pack install *depends-on* trust · Pack *blocks* marketplace (P2) · plugins binary *feeds* pack

## 5. Desktop Surfaces (P0.5)
| Nodo | Spec tokens | Azione |
|---|---|---|
| **TrustBadge** | `color.trust.*` | Header workspace 🔒/⚠ |
| **X-Ray drawer** | `space.xray.w` | Mirror inspect JSON pretty |
| **Context radar** | `color.context.ok/warn/crit` | Widget % allineato 70/85 |
| **TrustModal** | `space.modal.w` | Trust once / always / cancel |
| **Deep-links** | `zelari://inspect?section=` | Future; CLI first |

**Links:** X-Ray *mirrors* `/inspect` · Badge *reads* TrustStore · Modal *writes* trusted_folders

## 6. Non-goals (P2 / non rubare)
- ACP adapter · git worktree CoW · `/loop` · marketplace · riscrittura graph Rust · tool port Codex

---

## Priority spine (ship order)

```
P0: HookRunner → TrustStore → /trust → /inspect
P0.5: Desktop TrustBadge + X-Ray
P1: /context → /fork+/rewind → Pack v1 → mode auto
P2: ACP · worktree · /loop
```

## Cross-links ad artifact esistenti
- Comparazione → `docs/comparazione-harness-grok-build-vs-zelari-code.md`
- ADR 001 hooks+trust · 002 pack · 003 time-travel
- Arch wiring → `architettura-hooks-su-agentharness-folder-trust.md`
- IA · journey · tokens → Gerione docs (sitemap slash, personas, color.trust.*)
- Plan Nettuno → 4 fasi · choke-point `registry.ts` invoke

## UX acceptance (slash + Desktop)
1. Repo untrusted: nessun project hook/MCP; prompt trust; `/trust add` sblocca.
2. PreToolUse deny → riga `DENY: <tool> — <reason>` (non solo colore).
3. `/inspect` e X-Ray mostrano stesse sezioni; doctor resta install-only.
4. StatusBar: max trust badge + context% (no 6 badge).
5. `/fork` crea branch session; `/rewind n` ripristina transcript (non tree di default).
