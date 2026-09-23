---
kind: task
id: p1-session-ux-extensibility-context-radar-soglie-compact-70-85-6
phaseId: p1-session-ux-extensibility
status: pending
priority: high
tags: [src/cli/compaction.ts, packages/core, src/cli/slash/context.ts]
---
# /context radar + soglie compact 70/85

Slash /context con breakdown system/messages/tools/skills/free allineato a tokenBudget. Config threshold auto-compact; hook Pre/PostCompact dopo P0.

## File references
- `src/cli/compaction.ts`
- `packages/core`
- `src/cli/slash/context.ts`

## Acceptance criteria
- /context mostra breakdown e % free
- Soglie 70/85 configurabili o documentate
- Non rompe compaction sliding esistente

## QA scenario

Sessione lunga; /context; verifica % coerente con budget; compact opzionale.
