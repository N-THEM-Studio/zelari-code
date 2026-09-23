---
kind: task
id: p2-integrazione-editor-isolamento-scheduler-loop-leggero-headless-3
phaseId: p2-integrazione-editor-isolamento
status: pending
priority: low
tags: [src/cli/runHeadless.ts, src/cli/slashCommands.ts]
---
# Scheduler /loop leggero (headless)

Job ricorrente min 60s che rilancia prompt headless; persist job id; cancel.

## File references
- `src/cli/runHeadless.ts`
- `src/cli/slashCommands.ts`

## Acceptance criteria
- loop 1m esegue almeno 2 cicli in test con clock mock
- Cancel ferma job

## QA scenario

Creare loop 60s check; cancellare; nessun terzo run.
