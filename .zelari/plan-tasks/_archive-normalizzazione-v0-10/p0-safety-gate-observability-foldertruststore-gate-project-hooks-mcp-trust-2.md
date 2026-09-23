---
kind: task
id: p0-safety-gate-observability-foldertruststore-gate-project-hooks-mcp-trust-2
phaseId: p0-safety-gate-observability
status: pending
priority: critical
tags: [src/cli/safety/folderTrust.ts, src/cli/mcp/mcpManager.ts, src/cli/commands/trust.ts, src/cli/hooks/discovery.ts]
---
# FolderTrustStore + gate project hooks/MCP + /trust

Store ~/.zelari-code/trusted_folders.toml con path canonicalize (Windows-safe). Project hooks e project MCP solo se isTrusted(cwd). Slash /trust list|add|remove e flag --trust. Kill-switch ZELARI_FOLDER_TRUST=0 dev-only. Prompt one-shot migrazione per repo con .zelari/mcp.json già presenti.

## File references
- `src/cli/safety/folderTrust.ts`
- `src/cli/mcp/mcpManager.ts`
- `src/cli/commands/trust.ts`
- `src/cli/hooks/discovery.ts`

## Acceptance criteria
- Untrusted cwd → zero spawn project hooks (test automatico)
- Untrusted → project MCP non caricato (o prompt esplicito)
- Canonicalize evita bypass symlink/case
-  /trust add|remove|list funziona
- Kill-switch documentato SECURITY

## QA scenario

Repo untrusted con .zelari/hooks e mcp.json; avvio CLI; assert no hook process e no project MCP; /trust add .; riavvio; entrambi attivi.
