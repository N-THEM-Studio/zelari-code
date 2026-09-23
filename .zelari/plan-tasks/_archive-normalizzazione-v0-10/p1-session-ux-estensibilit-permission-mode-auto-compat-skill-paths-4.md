---
kind: task
id: p1-session-ux-estensibilit-permission-mode-auto-compat-skill-paths-4
phaseId: p1-session-ux-estensibilit
status: pending
priority: medium
tags: [src/cli/mode.ts, src/cli/skillsMd.ts, src/cli/safety/shellBlocklist.ts]
---
# Permission mode auto + compat skill paths

Mode auto: tool read-only e web safe auto-ok; write/execute prompt. Scan opzionale .claude/.cursor skills.

## File references
- `src/cli/mode.ts`
- `src/cli/skillsMd.ts`
- `src/cli/safety/shellBlocklist.ts`

## Acceptance criteria
- In auto, read_file non chiede conferma; bash sì
- Skill da .claude/skills caricata se compat abilitato

## QA scenario

Toggle auto; eseguire list_files senza prompt; bash npm test richiede conferma.
