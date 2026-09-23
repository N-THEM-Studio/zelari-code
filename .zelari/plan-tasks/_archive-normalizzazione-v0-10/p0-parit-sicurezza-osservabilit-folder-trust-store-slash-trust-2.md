---
kind: task
id: p0-parit-sicurezza-osservabilit-folder-trust-store-slash-trust-2
phaseId: p0-parit-sicurezza-osservabilit
status: pending
priority: critical
tags: [src/cli/mcp/mcpManager.ts, src/cli/main.ts, src/cli/slashCommands.ts]
---
# Folder trust store + slash /trust

Persistenza trusted folders; gate project MCP e project hooks. Flag --trust e env ZELARI_FOLDER_TRUST.

## File references
- `src/cli/mcp/mcpManager.ts`
- `src/cli/main.ts`
- `src/cli/slashCommands.ts`

## Acceptance criteria
- Project .zelari/mcp.json e hooks ignorati se cartella non trusted
- Dopo /trust o --trust i server MCP progetto si caricano
- Global ~/.zelari-code hooks sempre attivi

## QA scenario

Aprire repo con .zelari/mcp.json senza trust → MCP non caricati; /trust → reload → tool mcp_* disponibili.
