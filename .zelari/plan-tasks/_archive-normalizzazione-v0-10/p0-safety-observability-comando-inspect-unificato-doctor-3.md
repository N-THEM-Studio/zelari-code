---
kind: task
id: p0-safety-observability-comando-inspect-unificato-doctor-3
phaseId: p0-safety-observability
status: pending
priority: high
tags: [src/cli/utils/doctor.ts, src/cli/main.ts, src/cli/slashCommands.ts, src/cli/budget/tokenBudget.ts, src/cli/mcp/mcpManager.ts, src/cli/plugins/registry.ts]
---
# Comando inspect unificato (≠ doctor)

CLI zelari-code inspect e slash /inspect [--json] [--section=hooks|mcp|skills|plugins|trust|budget|agents]. Aggrega config sources, trust state, hooks caricati, MCP, skills, phase/mode, tokenBudget occupancy. doctor resta install-only.

## File references
- `src/cli/utils/doctor.ts`
- `src/cli/main.ts`
- `src/cli/slashCommands.ts`
- `src/cli/budget/tokenBudget.ts`
- `src/cli/mcp/mcpManager.ts`
- `src/cli/plugins/registry.ts`

## Acceptance criteria
- inspect --json schema stabile (version + sections)
- doctor non elenca hooks/MCP runtime
- /inspect section=trust mostra trusted yes/no per cwd

## QA scenario

zelari-code inspect --json | jq .sections.hooks; confrontare con doctor (solo install).
