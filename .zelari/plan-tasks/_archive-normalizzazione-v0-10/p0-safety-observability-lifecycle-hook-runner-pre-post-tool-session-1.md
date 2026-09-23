---
kind: task
id: p0-safety-observability-lifecycle-hook-runner-pre-post-tool-session-1
phaseId: p0-safety-observability
status: pending
priority: critical
tags: ["packages/core/src/core/tools/registry.ts:L112-L175", "packages/core/src/core/AgentHarness.ts:L324-L385", packages/core/src/core/tools/toolTypes.ts, src/cli/hooks/useChatTurn.ts, src/cli/runHeadless.ts, docs/TOOLS.md]
---
# Lifecycle hook runner (Pre/Post Tool + Session)

Modulo TS fail-open: discovery ~/.zelari-code/hooks + .zelari/hooks (solo se trusted), transport command (stdin JSON) e http opzionale. Aggancio primario in ToolRegistry.invoke prima di execute; eventi Session* da useChatTurn/runHeadless. Matcher regex + alias TOOL_NAME_ALIASES (Bash→bash). Solo decision:deny blocca.

## File references
- `packages/core/src/core/tools/registry.ts:L112-L175`
- `packages/core/src/core/AgentHarness.ts:L324-L385`
- `packages/core/src/core/tools/toolTypes.ts`
- `src/cli/hooks/useChatTurn.ts`
- `src/cli/runHeadless.ts`
- `docs/TOOLS.md`

## Acceptance criteria
- PreToolUse decision:deny blocca bash e propaga reason in tool_execution_end isError
- Crash/timeout hook non blocca tool (fail-open + log/audit)
- Matcher Bash e bash matchano lo stesso tool
- Project hooks ignorati se folder non trusted

## QA scenario

Creare ~/.zelari-code/hooks/deny-rm.json che deny bash se command ~ /rm\s+-rf/; invocare bash rm -rf /tmp/x → blocco + reason; rimuovere hook → tool ok.
