---
kind: task
id: p1-session-ux-extensibility-context-radar-context-auto-compact-config-2
phaseId: p1-session-ux-extensibility
status: pending
priority: high
tags: [src/cli/budget/tokenBudget.ts, src/cli/hooks/historyCompaction.ts, src/cli/compaction.ts, src/cli/components/StatusBar.tsx, src/cli/slashCommands.ts]
---
# Context radar /context + auto-compact config

Slash /context mostra occupancy tokenBudget (70 soft / 85 force / 95 hard), breakdown history/tools/system. Esporre soglie via env/config senza hardcode nascosti. Allineare feedback TUI StatusBar.

## File references
- `src/cli/budget/tokenBudget.ts`
- `src/cli/hooks/historyCompaction.ts`
- `src/cli/compaction.ts`
- `src/cli/components/StatusBar.tsx`
- `src/cli/slashCommands.ts`

## Acceptance criteria
- /context stampa % occupancy e soglie 70/85/95
- Warning soft a ≥70% coerente con policy esistente
- JSON opzionale --json per scripting

## QA scenario

Sessione lunga fino a soft-warn; /context conferma occupancy≥0.70 e suggerisce /compact.
