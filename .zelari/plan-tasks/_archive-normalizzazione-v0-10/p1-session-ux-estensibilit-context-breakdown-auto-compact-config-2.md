---
kind: task
id: p1-session-ux-estensibilit-context-breakdown-auto-compact-config-2
phaseId: p1-session-ux-estensibilit
status: pending
priority: high
tags: [src/cli/compaction.ts, src/cli/budget/tokenBudget.ts, src/cli/hooks/historyCompaction.ts]
---
# /context breakdown + auto-compact config

Mostrare uso context (system, messages, tools, skills, free). Soglia auto-compact configurabile (default ~85%).

## File references
- `src/cli/compaction.ts`
- `src/cli/budget/tokenBudget.ts`
- `src/cli/hooks/historyCompaction.ts`

## Acceptance criteria
- /context mostra percentuali e stime token
- Auto-compact scatta al threshold configurato e logga evento

## QA scenario

Sessione lunga: al superamento threshold compare compact automatico e /context free aumenta.
