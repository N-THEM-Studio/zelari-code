---
kind: task
id: p1-session-ux-extensibility-permission-mode-auto-compat-skill-paths-4
phaseId: p1-session-ux-extensibility
status: pending
priority: medium
tags: ["packages/core/src/core/AgentHarness.ts:L261-L279", src/cli/mode.ts, src/cli/phase.ts, src/cli/safety/shellBlocklist.ts, src/cli/components/StatusBar.tsx]
---
# Permission mode auto + compat skill paths

Mode permission auto: auto-approve tool parallel-safe (isParallelSafeTool) in agent mode; write/bash restano gated. Compat opzionale path skill/hooks Claude/Cursor se [compat] abilitato (solo lettura, no copy codice).

## File references
- `packages/core/src/core/AgentHarness.ts:L261-L279`
- `src/cli/mode.ts`
- `src/cli/phase.ts`
- `src/cli/safety/shellBlocklist.ts`
- `src/cli/components/StatusBar.tsx`

## Acceptance criteria
- Mode auto non esegue bash senza policy/hooks esistenti
- read_file/list_files non chiedono conferma in auto
- Compat off di default

## QA scenario

Impostare mode auto; read_file ok silenzioso; bash con blocklist ancora bloccato.
