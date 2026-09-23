---
kind: task
id: p1-session-ux-extensibility-capability-pack-v1-read-only-compat-claude-cursor-paths-7
phaseId: p1-session-ux-extensibility
status: pending
priority: medium
tags: [src/cli/plugins, .zelari/decisions/002-capability-pack-unificato-bridge-binary-plugins-grok-style.md]
---
# Capability Pack v1 read-only + compat Claude/Cursor paths

Manifesto locale che dichiara skills+slash+hooks+MCP hints (path only, no download). Install esplicito + trust. Bridge verso plugins/ binary esistenti senza due sistemi. Flag opt-in compat .claude/.cursor. Marketplace e mode-auto fuori scope.

## File references
- `src/cli/plugins`
- `.zelari/decisions/002-capability-pack-unificato-bridge-binary-plugins-grok-style.md`

## Acceptance criteria
- Pack v1 non scarica remote
- Install richiede trust/esplicito
- inspect elenca origine pack
- Compat paths dietro flag default off

## QA scenario

Installa pack locale di test; inspect mostra entry; nessun network; untrusted rifiuta enable hooks da pack.
