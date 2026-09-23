---
kind: task
id: p0-safety-observability-folder-trust-store-gate-mcp-hooks-2
phaseId: p0-safety-observability
status: pending
priority: critical
tags: ["src/cli/mcp/mcpManager.ts:L50-L70", src/cli/safety/sandboxPath.ts, src/cli/utils/paths.ts, "src/cli/slashCommands.ts:L3-L10", src/cli/main.ts, src/cli/hooks/useSlashDispatch.ts]
---
# Folder trust store + gate MCP/hooks

Store ~/.zelari-code/trusted_folders.toml (path canonici). API isTrusted(cwd), trust/untrust. Gate in readMcpConfig: project .zelari/mcp.json solo se trusted (user MCP globale sempre). Flag --trust, env ZELARI_FOLDER_TRUST=0 kill-switch. Slash /trust list|add|remove.

## File references
- `src/cli/mcp/mcpManager.ts:L50-L70`
- `src/cli/safety/sandboxPath.ts`
- `src/cli/utils/paths.ts`
- `src/cli/slashCommands.ts:L3-L10`
- `src/cli/main.ts`
- `src/cli/hooks/useSlashDispatch.ts`

## Acceptance criteria
- Progetto non trusted non carica .zelari/mcp.json né project hooks
- /trust add marca cwd; restart session carica MCP progetto
- ZELARI_FOLDER_TRUST=0 bypass documentato solo dev
- --trust on first run equivalente a /trust add

## QA scenario

Cartella nuova senza trust: MCP progetto assente in /inspect. /trust add → MCP tools presenti al prossimo turn.
