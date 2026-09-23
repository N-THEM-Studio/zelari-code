---
kind: task
id: p1-fork-rewind-context-radar-failover-context-radar-con-soglie-70-85-integrazione-context-2
phaseId: p1-fork-rewind-context-radar-failover
status: pending
priority: high
tags: [src/cli/compaction.ts, src/cli/slashHandlers/context.ts (se esiste) o workspace.ts, tests/unit/compaction-radar.test.ts (nuovo)]
---
# Context radar con soglie 70/85 + integrazione /context

Estendere src/cli/compaction.ts con radar: {tokensUsed, tokensBudget, percent, level:'safe'|'warn'|'critical', suggestions[]}. Soglie: 70% → warn (compaction preemptive), 85% → critical (compaction forzata + summary semantico via provider). Esposizione in /context (già presente) e via IPC in apps/desktop. Test: compaction-radar.test.ts (soglie, suggestions, integrazione /context).

## File references
- `src/cli/compaction.ts`
- `src/cli/slashHandlers/context.ts (se esiste) o workspace.ts`
- `tests/unit/compaction-radar.test.ts (nuovo)`

## Acceptance criteria
- Radar ritorna level corretto per soglie 70/85
- 70% triggera compaction preemptive senza summary semantico
- 85% triggera compaction forzata + summary semantico via provider
- /context mostra radar in TUI

## QA scenario

1. Fornire tokensUsed=70% → /context mostra warn. 2. Fornire tokensUsed=85% → /context mostra critical e compaction forzata eseguita.
