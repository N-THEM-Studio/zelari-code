---
kind: task
id: p1-5-governance-drift-check-consolidamento-piano-drift-check-in-postcouncilhook-ts-plan-json-canonical-1
phaseId: p1-5-governance-drift-check-consolidamento-piano
status: pending
priority: high
tags: [src/cli/workspace/postCouncilHook.ts, .zelari/docs/plan-canonical-v0-10.md, tests/unit/postCouncilHook-drift.test.ts (nuovo)]
---
# drift-check in postCouncilHook.ts (plan.json ↔ canonical)

Aggiungere step driftCheck in src/cli/workspace/postCouncilHook.ts: confronto .zelari/plan.json (lettura+parse) ↔ .zelari/docs/plan-canonical-v0-10.md (parse sezione ## Tasks). Verifica: cardinalità task, ID univoci, slug consistenti, fasi non vuote. Drift → PostCouncilHookResult.drift={ok:false,diffs:[...]} + warning console + entry in completion.json. Test: postCouncilHook-drift.test.ts (plan identico → ok; mutato → fail con diff).

## File references
- `src/cli/workspace/postCouncilHook.ts`
- `.zelari/docs/plan-canonical-v0-10.md`
- `tests/unit/postCouncilHook-drift.test.ts (nuovo)`

## Acceptance criteria
- drift.ok=true quando plan.json e canonical sono allineati
- drift.ok=false con diff esplicito quando cardinality/ID/slug differiscono
- Warning console + completion.json aggiornato

## QA scenario

1. Plan identico al canonical → drift.ok=true. 2. Aggiungere task fake al plan.json → drift.ok=false con diff.
