---
kind: doc
id: knowledge-map-workspace-state-v0-10
date: 2026-07-16
tags: [knowledge-map, workspace-state, council, v0.10, grok-build]
related: [knowledge-map, plan-canonical-v0-10, synthesis]
---
---
kind: doc
id: knowledge-map-workspace-state-v0-10
date: 2026-07-16
tags: [knowledge-map, workspace-state, council, v0.10, grok-build]
related: [knowledge-map, synthesis, plan-canonical-v0-10]
---
# Knowledge Map — Workspace State v0.10 (Layer 0)

> Plutone · design-phase · workspace awareness · complementare a [[knowledge-map]] (Layer 1 = product surface)

```
                  ┌──────────────────────────────────────┐
                  │ zelari-code v0.10 "Steal Grok Build" │
                  │ MIT · Node 20 · TS 5.7 · Ink + Tauri │
                  └──────────────────┬───────────────────┘
       ┌──────────┬──────────┬────────┼────────┬──────────┬──────────┐
       ▼          ▼          ▼        ▼        ▼          ▼          ▼
    Council    Artifacts   Stato   Piano    Gaps       Conv.    Pending
```

## 1 · Council (6 agenti, design-phase)
- **Caronte** (dir) discovery → 3 opzioni pending
- **Nettuno** (plan) → `createPlan` 4 fasi × 3 task, milestone v0.10.0
- **Gerione** (UX/idee) → 3 doc design-phase (esistenti) + `gerione-divergent-ideas-v0-11-spikes` + ADR 005
- **Plutone** (io) → questa mappa + `knowledge-map` (Layer 1)
- **Minosse** (risks) → `risks.md` (ridondante, gap R15)
- **Lucifero** (chair) → `synthesis.md` GO P0+P0.5, NO-GO P2/mode-auto

## 2 · Workspace artifacts (`.zelari/`)
- `docs/` (10): synthesis, plan-canonical-v0-10, knowledge-map, customer-journey-map, information-architecture, design-tokens, gerione-divergent-ideas-v0-11-spikes, comparazione, architettura-hooks, steal-list
- `decisions/` (5 ADR): 001 hooks+trust · 002 capability-pack · 003 time-travel · 004 cut-list P2 · **005 shadow-council (nuova, Gerione)**
- `milestones/` (3): m-v0-10-0-steal-grok-build-shipped (target) + 2 storiche harness-parity
- `plan.json` (duplicato) + `plan.md` + ~25 file in `plan-tasks/`

## 3 · Stato corrente
- Handoff v0.7.8 (2026-07-03, Opzione B)
- Ultimo plan canonico 2026-07-16, tema v0.10 "Steal Grok Build"
- **Mission `m_fd0f70ad` running con prompt `"x"`** (placeholder — blocker per run implementation)
- Auth Claude CLI scaduta → workaround `composer-2.5`
- Verdetto Lucifero: **GO P0+P0.5, NO-GO P2 + mode-auto**

## 4 · Gap noti (HANDOFF.md + Gerione R15)
- **R3** piano duplicato (11 fasi / 2 milestone) → merge via `createPlan` da `plan-canonical-v0-10`
- **R15** post-processor: 4 task generici vs 12 curati (drift quality)
- `councilApi.ts` 1138 LOC → split (vincolo ≤ 300 LOC)
- Dependabot: 1 critical + 1 high + 3 moderate
- `risks-md.md` ridondante vs `risks.md` canonico → cleanup

## 5 · Convenzioni (vincolanti)
- File ≤ 300 LOC · Zod schemas · single-task atomic commit
- Stack: `@zelari/core` + Tauri desktop + Ink CLI + 5 MCP server
- Zero nuove deps pesanti · NFR animation budget (compone `createNfrSpec`)

## 6 · Decisioni pending (output Caronte)
- (a) **merge plan** → `createPlan` atomo da `plan-canonical-v0-10.md`
- (b) **chiudere gap** HANDOFF (post-processor + cleanup `risks-md.md` + split `councilApi.ts`)
- (c) **nuovo run** implementation P0 con prompt reale (no `"x"`)
- Suggerimento Nettuno+Gerione: **(a)+(b) in sequenza** prima di (c)

## Cross-link bidirezionali
- → [[knowledge-map]] (Layer 1 product surface · feature spine)
- → [[plan-canonical-v0-10]] · [[synthesis]] · [[steal-list-v0-10-acceptance]]
- → ADR [[001-adr-lifecycle-hooks-folder-trust]] · [[004-adr-cut-list]] · [[005-adr-idea-shadow-council]]

## Acceptance
- Layer 0 (questa) + Layer 1 (`knowledge-map`) coprono 100% del workspace senza duplicati
- Ogni branch ha ≥ 2 foglie azionabili · tutti gli ADR recenti sono referenziati
