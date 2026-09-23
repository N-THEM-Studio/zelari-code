---
kind: task
id: p0-hook-lifecycle-folder-trust-inspect-comando-inspect-con-output-json-versionato-3
phaseId: p0-hook-lifecycle-folder-trust-inspect
status: pending
priority: high
tags: [src/cli/slashHandlers/inspect.ts (nuovo), packages/core/src/inspect/schema.ts (nuovo), tests/unit/cli-inspect.test.ts (nuovo), src/cli/slashCommands.ts (dispatch)]
---
# Comando /inspect con output JSON versionato

Creare src/cli/slashHandlers/inspect.ts che emette JSON versionato: {version:1, trust, hooks:{registered,lastEmits}, mcp:{servers,allowedOnUntrusted}, skills, plugins, phase, mode, sessionId}. Schema in packages/core/src/inspect/schema.ts (zod). Dispatch nel router slash. Test: cli-inspect.test.ts con validazione schema.

## File references
- `src/cli/slashHandlers/inspect.ts (nuovo)`
- `packages/core/src/inspect/schema.ts (nuovo)`
- `tests/unit/cli-inspect.test.ts (nuovo)`
- `src/cli/slashCommands.ts (dispatch)`

## Acceptance criteria
- Output JSON conforme a schema zod version 1
- Sezioni trust, hooks, mcp, skills, plugins, phase, mode, sessionId presenti
- Serializzazione stabile (test snapshot)

## QA scenario

1. /inspect su cwd trusted → JSON con trust.scope='project'. 2. /inspect su cwd untrusted → JSON con hooks.lastEmits=[].
