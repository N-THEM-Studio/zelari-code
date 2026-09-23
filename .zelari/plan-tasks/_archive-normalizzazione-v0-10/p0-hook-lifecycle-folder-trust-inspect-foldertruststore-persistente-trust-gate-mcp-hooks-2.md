---
kind: task
id: p0-hook-lifecycle-folder-trust-inspect-foldertruststore-persistente-trust-gate-mcp-hooks-2
phaseId: p0-hook-lifecycle-folder-trust-inspect
status: pending
priority: critical
tags: [packages/core/src/folderTrust/FolderTrustStore.ts (nuovo), packages/core/src/folderTrust/FolderTrustStore.test.ts (nuovo), packages/core/src/core/tools/registry.ts (gate), src/cli/slashHandlers/workspace.ts (dispatch /trust), tests/unit/untrusted-zero-spawn.test.ts (nuovo)]
---
# FolderTrustStore persistente + /trust + gate MCP/hooks

Creare packages/core/src/folderTrust/FolderTrustStore.ts con persistenza in .zelari/trust.json ({[projectId]:{scope:'project'|'global', path, allowedAt, allowedBy}}). canonicalize() via path.resolve+realpath con try/catch Windows symlink. isTrusted(cwd) con lookup progetto+fallback globale. Integrare in ToolRegistry.invoke come gate: su untrusted bloccare tutti i tool che fanno spawn/write/network; consentire solo read-only (read_file, list_files, grep_content, searchDocuments). Comandi /trust grant|revoke|list in src/cli/slashHandlers/workspace.ts. Test: FolderTrustStore.test.ts + untrusted-zero-spawn.test.ts.

## File references
- `packages/core/src/folderTrust/FolderTrustStore.ts (nuovo)`
- `packages/core/src/folderTrust/FolderTrustStore.test.ts (nuovo)`
- `packages/core/src/core/tools/registry.ts (gate)`
- `src/cli/slashHandlers/workspace.ts (dispatch /trust)`
- `tests/unit/untrusted-zero-spawn.test.ts (nuovo)`

## Acceptance criteria
- trust.json persistito correttamente con scope project|global
- canonicalize() risolve symlink Windows senza crash
- Su cwd untrusted, ZERO spawn/write/network; solo read-only ammessi
- /trust grant|revoke|list funzionanti e testati

## QA scenario

1. cwd non trusted → invocare shell tool → errore gate. 2. /trust grant project → invocare shell tool → successo. 3. grep_content su untrusted → consentito (read-only).
