---
kind: task
id: p0-5-desktop-mirror-docs-test-harness-hooks-trust-unitari-3
phaseId: p0-5-desktop-mirror-docs
status: pending
priority: high
tags: [tests/unit, packages/core/src/core/tools/registry.ts, src/cli/mcp/mcpManager.ts]
---
# Test harness hooks/trust unitari

Unit test: deny PreToolUse, fail-open timeout, trust gate MCP, inspect JSON schema. Fixture pack minimo.

## File references
- `tests/unit`
- `packages/core/src/core/tools/registry.ts`
- `src/cli/mcp/mcpManager.ts`

## Acceptance criteria
- CI verde con ≥6 test nuovi hooks/trust/inspect
- Nessun test esegue hook di rete reale (http mock)

## QA scenario

npm test — suite hooks-trust passa in <30s.
