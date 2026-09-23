---
kind: task
id: p0-parit-sicurezza-osservabilit-lifecycle-hook-runner-su-agentharness-1
phaseId: p0-parit-sicurezza-osservabilit
status: pending
priority: critical
tags: [packages/core/src/core/AgentHarness.ts, src/cli/toolRegistry.ts, docs/TOOLS.md]
---
# Lifecycle hook runner su AgentHarness

Implementare runner hook (command + optional http) agganciato a PreToolUse/PostToolUse/SessionStart/End. Fail-open; deny solo con JSON decision. Matcher tool + alias Claude-like.

## File references
- `packages/core/src/core/AgentHarness.ts`
- `src/cli/toolRegistry.ts`
- `docs/TOOLS.md`

## Acceptance criteria
- PreToolUse con decision deny blocca bash e mostra reason in TUI
- Hook crash/timeout non blocca tool (fail-open loggato)
- Matcher Bash e bash entrambi matchano tool bash

## QA scenario

Creare ~/.zelari-code/hooks/deny-rm.json che deny comandi con rm -rf; invocare bash rm -rf /tmp/x e verificare blocco + reason.
