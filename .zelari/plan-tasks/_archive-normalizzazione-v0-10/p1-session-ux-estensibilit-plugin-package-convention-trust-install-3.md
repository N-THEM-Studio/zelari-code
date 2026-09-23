---
kind: task
id: p1-session-ux-estensibilit-plugin-package-convention-trust-install-3
phaseId: p1-session-ux-estensibilit
status: pending
priority: medium
tags: [src/cli/plugins/installer.ts, src/cli/plugins/registry.ts, src/cli/slashHandlers/plugins.ts]
---
# Plugin package convention + trust install

Directory plugin con skills/, commands/, hooks/, .mcp.json; install da path/git con --trust; enable/disable.

## File references
- `src/cli/plugins/installer.ts`
- `src/cli/plugins/registry.ts`
- `src/cli/slashHandlers/plugins.ts`

## Acceptance criteria
- Plugin trusted espone skill e hook
- Plugin untrusted: skill metadata visibile, hook/MCP non eseguiti

## QA scenario

Installare plugin locale di test senza --trust → hooks non fire; con --trust → PostToolUse logga.
