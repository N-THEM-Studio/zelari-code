---
kind: task
id: p2-editor-isolation-adapter-acp-stdio-su-agentharness-1
phaseId: p2-editor-isolation
status: pending
priority: medium
tags: ["packages/core/src/core/AgentHarness.ts:L502-L723", src/cli/runHeadless.ts, src/cli/headless.ts, src/cli/main.ts, packages/core/src/harness/index.ts]
---
# Adapter ACP stdio su AgentHarness

Bridge stdio JSON-RPC minimo (initialize, prompt, cancel) che wrappa AgentHarness + tool registry CLI. Non sostituire TUI; entry opzionale zelari-code --acp.

## File references
- `packages/core/src/core/AgentHarness.ts:L502-L723`
- `src/cli/runHeadless.ts`
- `src/cli/headless.ts`
- `src/cli/main.ts`
- `packages/core/src/harness/index.ts`

## Acceptance criteria
- --acp risponde a initialize con capabilities
- prompt end-to-end esegue un tool read_file in fixture
- cancel aborta activeController

## QA scenario

Client ACP mock invia prompt 'list root'; riceve tool calls + testo finale.
