---
kind: task
id: chiusura-gap-handoff-post-processor-post-processor-curare-task-generici-in-specifici-1
phaseId: chiusura-gap-handoff-post-processor
status: pending
priority: high
tags: [packages/core/src/planner/post-processor.ts, "HANDOFF.md:L20-L40"]
---
# Post-processor: curare task generici in specifici

HANDOFF #1: il post-processor emette 4 task generici invece di 12 curati. Aggiungere/fixare il fuzzy match che ri-aggancia ogni task generico al template curato (fileRefs reali, acceptance testabili, qaScenario).

## File references
- `packages/core/src/planner/post-processor.ts`
- `HANDOFF.md:L20-L40`

## Acceptance criteria
- Data una richiesta generica tipo 'implementa hooks', l'output contiene ≥12 task con fileRefs unici
- Ogni task ha almeno 1 acceptance criterion testabile e 1 qaScenario eseguibile
- Test unitario sul post-processor verde

## QA scenario

npm test -- post-processor: output deve contenere ≥12 task con fileRefs non vuoti e ≥1 acceptance ciascuno.
