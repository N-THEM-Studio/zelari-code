---
kind: task
id: p0-hook-lifecycle-folder-trust-inspect-lifecyclehookrunner-integrazione-toolregistry-invoke-1
phaseId: p0-hook-lifecycle-folder-trust-inspect
status: pending
priority: critical
tags: [packages/core/src/core/tools/LifecycleHookRunner.ts (nuovo), packages/core/src/core/tools/LifecycleHookRunner.test.ts (nuovo), packages/core/src/core/tools/registry.ts, packages/core/src/core/tools/auditLog.ts]
---
# LifecycleHookRunner + integrazione ToolRegistry.invoke

Creare packages/core/src/core/tools/LifecycleHookRunner.ts con eventi PreToolUse/PostToolUse/PostToolUseFailure/SessionStart/SessionEnd. Agganciare in ToolRegistry.invoke (packages/core/src/core/tools/registry.ts): emit PreToolUse prima di Promise.race, emit Post/PostToolUseFailure in try/catch/finally. Deny esplicito (handler ritorna {decision:'deny',reason}). Timeout 5s per handler via AbortController. Fail-open: eccezione/timeout → log su auditLog.ts e procedere. Test: LifecycleHookRunner.test.ts (deny, timeout, fail-open, ordering).

## File references
- `packages/core/src/core/tools/LifecycleHookRunner.ts (nuovo)`
- `packages/core/src/core/tools/LifecycleHookRunner.test.ts (nuovo)`
- `packages/core/src/core/tools/registry.ts`
- `packages/core/src/core/tools/auditLog.ts`

## Acceptance criteria
- Hook PreToolUse blocca invoke con typedErr quando ritorna decision:deny
- Hook che eccede 5s non blocca invoke (fail-open + log audit)
- PostToolUse/PostToolUseFailure emessi in ogni caso (try/finally)
- Test verdi: deny, timeout, fail-open, ordering Pre→Post

## QA scenario

1. npm run typecheck → exit 0. 2. npx vitest run packages/core/src/core/tools/LifecycleHookRunner.test.ts → tutti i test verdi. 3. Verifica manuale: hook PreToolUse con deny blocca shell.invoke con messaggio 'denied by hook'.
