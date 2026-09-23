---
kind: task
id: p1-5-governance-drift-check-consolidamento-piano-consolidamento-3-milestone-v0-10-0-in-1-canonical-plan-json--2
phaseId: p1-5-governance-drift-check-consolidamento-piano
status: pending
priority: high
tags: [.zelari/milestones/m-v0-10-0-canonical.md (nuovo), .zelari/milestones/_archive/v0-10-0/ (directory archivio), .zelari/plan.json (riduzione 47→12 task)]
---
# Consolidamento 3 milestone v0.10.0 in 1 canonical + plan.json ridotto

Creare .zelari/milestones/m-v0-10-0-canonical.md unico (con scope, exit criteria, targetVersion 1.15.0). Archiviare i 3 duplicati in .zelari/milestones/_archive/v0-10-0/ con prefisso _archived-. Aggiornare .zelari/plan.json: 1 milestone v0.10.0, 12 task ship-path, tutti gli altri status:'blocked' con reason:'descoped to v0.11.0'. Rimuovere fasi placeholder (milestone-holder).

## File references
- `.zelari/milestones/m-v0-10-0-canonical.md (nuovo)`
- `.zelari/milestones/_archive/v0-10-0/ (directory archivio)`
- `.zelari/plan.json (riduzione 47→12 task)`

## Acceptance criteria
- 1 solo file milestone v0.10.0 attivo
- 3 duplicati archiviati in _archive/
- plan.json: 12 task non blocked, restanti con reason:'descoped to v0.11.0'
- Nessuna fase placeholder (milestone-holder rimosso)

## QA scenario

1. ls .zelari/milestones → solo m-v0-10-0-canonical.md. 2. jq '.tasks | length' .zelari/plan.json → 12. 3. jq '.tasks[] | select(.status!=\"blocked\") | .id' .zelari/plan.json | wc -l → 12.
