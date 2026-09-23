---
kind: task
id: p1-fork-rewind-context-radar-failover-branch-manager-fork-e-rewind-fork-rewind-1
phaseId: p1-fork-rewind-context-radar-failover
status: pending
priority: high
tags: [src/cli/branchManager.ts, src/cli/slashHandlers/branch.ts, tests/unit/branchManager-fork-rewind.test.ts (nuovo)]
---
# Branch manager: fork() e rewind() + /fork + /rewind

Estendere src/cli/branchManager.ts con fork(sessionId) e rewind(sessionId, stepId). Snapshot atomico via git stash + tag locale zelari-fork/<id>. Comandi /fork e /rewind in src/cli/slashHandlers/branch.ts (dispatch). Test: branchManager-fork-rewind.test.ts (snapshot, restore, idempotenza tag).

## File references
- `src/cli/branchManager.ts`
- `src/cli/slashHandlers/branch.ts`
- `tests/unit/branchManager-fork-rewind.test.ts (nuovo)`

## Acceptance criteria
- fork() crea tag zelari-fork/<id> atomico
- rewind() ripristina stato fino a stepId senza perdere history
- /fork e /rewind accessibili dalla TUI con feedback

## QA scenario

1. /fork → tag locale presente (git tag --list 'zelari-fork/*'). 2. /rewind → stato ripristinato, history intatta.
