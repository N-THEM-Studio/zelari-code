---
kind: task
id: p1-session-ux-extensibility-capability-pack-v1-bridge-plugins-skills-hooks-mcp-3
phaseId: p1-session-ux-extensibility
status: pending
priority: medium
tags: [src/cli/plugins/installer.ts, src/cli/plugins/registry.ts, src/cli/plugins/prefs.ts, src/cli/slashHandlers/plugins.ts, src/cli/components/PluginGate.tsx, .zelari/decisions/002-capability-pack-unificato-bridge-binary-plugins-grok-style.md]
---
# Capability Pack v1 (bridge plugins → skills/hooks/MCP)

Manifest pack.json: skills/, commands/, hooks/, mcp hints, optional binaryDeps. Install path/git con trust gate; v1 read-only (no auto marketplace). Bridge installer/registry esistenti senza rompere binary plugins.

## File references
- `src/cli/plugins/installer.ts`
- `src/cli/plugins/registry.ts`
- `src/cli/plugins/prefs.ts`
- `src/cli/slashHandlers/plugins.ts`
- `src/cli/components/PluginGate.tsx`
- `.zelari/decisions/002-capability-pack-unificato-bridge-binary-plugins-grok-style.md`

## Acceptance criteria
- Pack locale installabile con --trust mostra skills+hooks in /inspect
- Pack da path non trusted rifiutato con messaggio chiaro
- Binary plugin legacy continua a funzionare

## QA scenario

Pack fixture tests/fixtures/sample-pack → install → /inspect section=plugins elenca skills del pack.
