---
kind: task
id: p1-fork-rewind-context-radar-failover-capability-pack-read-only-alias-claude-cursor-4
phaseId: p1-fork-rewind-context-radar-failover
status: pending
priority: medium
tags: [packages/core/src/capabilities/readonly.ts (nuovo), packages/core/src/core/tools/registry.ts (alias map), tests/unit/readonly.test.ts (nuovo)]
---
# Capability Pack read-only + alias Claude/Cursor

Creare packages/core/src/capabilities/readonly.ts: marker {readOnly:true} per tool che non mutano. ToolRegistry espone getReadOnlyTools(). Completare TOOL_NAME_ALIASES in registry.ts:19-44 con Write, Edit, Glob, Grep, WebFetch (alias Claude/Cursor). Test: readonly.test.ts (getReadOnlyTools ritorna solo marker, alias risolvono a tool corretti).

## File references
- `packages/core/src/capabilities/readonly.ts (nuovo)`
- `packages/core/src/core/tools/registry.ts (alias map)`
- `tests/unit/readonly.test.ts (nuovo)`

## Acceptance criteria
- getReadOnlyTools() ritorna solo tool con marker readOnly
- TOOL_NAME_ALIASES mappa Write→write_file, Edit→edit_file, Glob→list_files, Grep→grep_content, WebFetch→fetch_url
- Test verde per marker e alias

## QA scenario

1. getReadOnlyTools() in shell disattivato → ritorna [] (perché shell è mutating). 2. Alias 'Grep' → risolve a grep_content correttamente.
