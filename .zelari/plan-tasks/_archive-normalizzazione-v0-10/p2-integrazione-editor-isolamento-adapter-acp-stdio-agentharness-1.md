---
kind: task
id: p2-integrazione-editor-isolamento-adapter-acp-stdio-agentharness-1
phaseId: p2-integrazione-editor-isolamento
status: pending
priority: medium
tags: [src/cli/runHeadless.ts, packages/core/src/core/AgentHarness.ts]
---
# Adapter ACP stdio → AgentHarness

Implementare subset ACP (session/new, prompt, tool permission) mappato su headless/harness. Nessuna dipendenza binaria grok.

## File references
- `src/cli/runHeadless.ts`
- `packages/core/src/core/AgentHarness.ts`

## Acceptance criteria
- Editor ACP-compatible avvia sessione e riceve stream eventi
- Tool permission round-trip funziona

## QA scenario

Con client ACP di test, inviare prompt 'list root files' e ricevere tool call + result.
