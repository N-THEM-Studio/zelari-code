---
kind: task
id: p1-session-ux-estensibilit-session-fork-e-rewind-1
phaseId: p1-session-ux-estensibilit
status: pending
priority: high
tags: [src/cli/sessionManager.ts, src/cli/checkpoint/checkpointManager.ts, src/cli/slashCommands.ts]
---
# Session fork e rewind

Slash /fork (branch session JSONL) e /rewind N (tronca turni + opzionale checkpoint file). Riusare sessionManager e checkpointManager.

## File references
- `src/cli/sessionManager.ts`
- `src/cli/checkpoint/checkpointManager.ts`
- `src/cli/slashCommands.ts`

## Acceptance criteria
- /rewind 1 elimina ultimo turno assistant+tool dal contesto inviato al provider
- /fork crea nuova session id con history copiata fino al punto

## QA scenario

Conversazione 3 turni → /rewind 1 → invio prompt: modello non vede ultimo tool result.
