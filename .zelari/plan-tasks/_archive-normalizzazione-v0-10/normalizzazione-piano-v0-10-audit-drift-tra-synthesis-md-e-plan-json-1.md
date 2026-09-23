---
kind: task
id: normalizzazione-piano-v0-10-audit-drift-tra-synthesis-md-e-plan-json-1
phaseId: normalizzazione-piano-v0-10
status: pending
priority: high
tags: [.zelari/plan.json, .zelari/synthesis.md, "HANDOFF.md:L1-L80"]
---
# Audit drift tra synthesis.md e plan.json

Verificare se .zelari/plan.json riflette ancora il piano duplicato (11 fasi, 2 milestone) oppure è già stato normalizzato. Cross-check con verdetto Lucifero: GO su P0+P0.5, NO-GO su P2 e mode-auto.

## File references
- `.zelari/plan.json`
- `.zelari/synthesis.md`
- `HANDOFF.md:L1-L80`

## Acceptance criteria
- Diff strutturale tra plan.json attuale e synthesis.md prodotto come nota
- Lista fasi duplicate e milestone ridondanti identificata per ID
- Verdetto GO/NO-GO di Lucifero mappato 1:1 sulle fasi superstiti

## QA scenario

Aprire .zelari/plan.json e contare le fasi: se >6 il drift è confermato. Verificare che 'mode-auto' compaia tra le fasi da rimuovere.
