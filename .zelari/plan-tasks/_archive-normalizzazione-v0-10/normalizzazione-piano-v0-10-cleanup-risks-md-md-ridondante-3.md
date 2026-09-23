---
kind: task
id: normalizzazione-piano-v0-10-cleanup-risks-md-md-ridondante-3
phaseId: normalizzazione-piano-v0-10
status: pending
priority: medium
tags: [.zelari/risks-md.md, .zelari/risks.json, .zelari/synthesis.md]
---
# Cleanup risks-md.md ridondante

Rimuovere o consolidare .zelari/risks-md.md se duplica risks.json / synthesis.md (gap HANDOFF #2). Decisione: tenere solo un formato canonico.

## File references
- `.zelari/risks-md.md`
- `.zelari/risks.json`
- `.zelari/synthesis.md`

## Acceptance criteria
- Esiste un solo file risks canonico (md o json) referenziato da plan
- Documento eliminato o vuoto con nota di redirect
- Nessun riferimento broken in plan.json o HANDOFF.md

## QA scenario

grep -r 'risks-md' .zelari/ deve restituire 0 riferimenti attivi dopo cleanup.
