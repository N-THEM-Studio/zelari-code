---
kind: task
id: p1-session-ux-extensibility-session-fork-rewind-su-transcript-branch-1
phaseId: p1-session-ux-extensibility
status: pending
priority: high
tags: [src/cli/branchManager.ts, src/cli/sessionManager.ts, src/cli/checkpoint/checkpointManager.ts, packages/core/src/core/sessionJsonl.ts, src/cli/slashHandlers/branch.ts, src/cli/slashHandlers/checkpoint.ts, src/cli/slashCommands.ts]
---
# Session fork + rewind su transcript/branch

Slash /fork clona sessione JSONL + branchManager; /rewind N o a checkpoint id. Default rewind = transcript-only (no filesystem CoW). Checkpoint opt-in resta su checkpointManager.

## File references
- `src/cli/branchManager.ts`
- `src/cli/sessionManager.ts`
- `src/cli/checkpoint/checkpointManager.ts`
- `packages/core/src/core/sessionJsonl.ts`
- `src/cli/slashHandlers/branch.ts`
- `src/cli/slashHandlers/checkpoint.ts`
- `src/cli/slashCommands.ts`

## Acceptance criteria
- /fork crea nuova sessionId con history copiata
- /rewind 3 rimuove ultimi 3 turn user/assistant dal transcript attivo
- Rewind non ripristina file workspace di default

## QA scenario

Chat 5 turn → /fork → continuare su fork; sull'originale /rewind 2 e verificare messaggi.
