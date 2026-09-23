---
kind: task
id: chiusura-gap-handoff-post-processor-quality-gate-ogni-task-deve-avere-filerefs-acceptance-qascen-2
phaseId: chiusura-gap-handoff-post-processor
status: pending
priority: high
tags: [packages/core/src/planner/schema.ts, packages/core/src/planner/validator.ts]
---
# Quality gate: ogni task deve avere fileRefs+acceptance+qaScenario

Aggiungere validator (Zod schema) che blocca createTask se mancano fileRefs/acceptance/qaScenario. Previene la regressione del gap #1.

## File references
- `packages/core/src/planner/schema.ts`
- `packages/core/src/planner/validator.ts`

## Acceptance criteria
- Validator Zod rifiuta task senza fileRefs o acceptance vuote
- Errore esplicito menziona i campi mancanti
- Test copre casi limite: array vuoti, undefined, whitespace

## QA scenario

Chiamare createTask con title='X', acceptance=[]: deve lanciare ValidationError con messaggio che cita 'acceptance'.
