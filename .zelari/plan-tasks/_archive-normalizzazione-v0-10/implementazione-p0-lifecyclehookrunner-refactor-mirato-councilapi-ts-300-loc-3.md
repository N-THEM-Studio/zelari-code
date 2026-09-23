---
kind: task
id: implementazione-p0-lifecyclehookrunner-refactor-mirato-councilapi-ts-300-loc-3
phaseId: implementazione-p0-lifecyclehookrunner
status: pending
priority: medium
tags: [src/cli/councilApi.ts, src/cli/councilApi/handlers/, src/cli/councilApi/core/]
---
# Refactor mirato councilApi.ts (>300 LOC)

Estrarre almeno 2 responsabilità da councilApi.ts (1138 LOC) in moduli separati, ciascuno ≤300 LOC. Target: separare IPC layer da business logic.

## File references
- `src/cli/councilApi.ts`
- `src/cli/councilApi/handlers/`
- `src/cli/councilApi/core/`

## Acceptance criteria
- Almeno 2 nuovi file ≤300 LOC creati con responsabilità singola
- councilApi.ts import-export invariato (backward compat)
- Test esistenti ancora verdi

## QA scenario

find src/cli/councilApi* -name '*.ts' -exec wc -l {} \;: nessun file >300 LOC. `npm test` verde.
