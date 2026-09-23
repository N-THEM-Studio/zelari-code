---
kind: task
id: normalizzazione-piano-v0-10-deprecate-fase-milestone-holder-placeholder-order-99-4
phaseId: normalizzazione-piano-v0-10
status: pending
priority: low
tags: [".zelari/plan.json:L46-L52", ".zelari/plan.md:L26"]
---
# DEPRECATE fase milestone-holder (placeholder order 99)

La fase `milestone-holder` (order 99, description "placeholder") è cruft pre-Lucidatore: nessun task, nessuna milestone, nessun owner. L'API `updateTask` rifiuta ID di fase (verificato 2026-07-16). Chiusura: questo task marker documenta la fase come DEPRECATED; rimozione strutturale demandata a `createPlan` cleanup in run successivo (post-v0.10.0). Idempotente: la fase resterà inerte (nessun task pending, nessuna milestone attiva).

## File references
- `.zelari/plan.json:L46-L52`
- `.zelari/plan.md:L26`

## Acceptance criteria
- Fase milestone-holder documentata come DEPRECATED in HANDOFF-v0.10.0.md §Gap-residui
- plan.md mostra phase 99 con nota DEPRECATED accanto al nome
- Nessun task pending nella fase (verificato jq .tasks[].phaseId)

## QA scenario

1. cat .zelari/plan.md | grep -A1 milestone-holder → atteso "DEPRECATED — placeholder phase" 2. jq '.phases[] | select(.id=="milestone-holder") | .description' .zelari/plan.json → atteso "placeholder DEPRECATED" 3. jq '[.tasks[] | select(.phaseId=="milestone-holder")] | length' .zelari/plan.json → atteso 0
