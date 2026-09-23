---
kind: task
id: p0-safety-gate-observability-lifecyclehookrunner-wire-toolregistry-invoke-1
phaseId: p0-safety-gate-observability
status: pending
priority: critical
tags: [packages/core/src/core/tools/registry.ts, packages/core/src/core/AgentHarness.ts, packages/core/src/core/hooks/types.ts, packages/core/src/core/hooks/runner.ts]
---
# LifecycleHookRunner + wire ToolRegistry.invoke

Interfaccia LifecycleHookRunner in core (iniettabile), eventi PreToolUse/PostToolUse/PostToolUseFailure/Session*. Wire in ToolRegistry.invoke DOPO phase/blocklist/sandbox e PRIMA di tool.execute. Fail-open; deny solo JSON esplicito; timeout 5s; updatedInput disabilitato v1. Pattern Grok, reimpl TS (no copy Apache-2.0).

## File references
- `packages/core/src/core/tools/registry.ts`
- `packages/core/src/core/AgentHarness.ts`
- `packages/core/src/core/hooks/types.ts`
- `packages/core/src/core/hooks/runner.ts`

## Acceptance criteria
- PreToolUse deny blocca execute e propaga reason
- Crash/timeout/JSON invalido → allow + audit FAIL-OPEN
- Ordine: phase → sandbox/blocklist → PreToolUse → execute → PostToolUse
- updatedInput ignorato o assente in v1
- Test unitari deny + fail-open

## QA scenario

Registra runner mock deny su bash; invoca tool; assert no execute. Runner che throw; assert execute + FAIL-OPEN log.
