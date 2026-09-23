---
kind: task
id: implementazione-p0-lifecyclehookrunner-wire-lifecyclehookrunner-in-toolregistry-invoke-1
phaseId: implementazione-p0-lifecyclehookrunner
status: pending
priority: critical
tags: [packages/core/src/runtime/tool-registry.ts, packages/core/src/runtime/lifecycle-hooks.ts]
---
# Wire LifecycleHookRunner in ToolRegistry.invoke

Instrumentare packages/core/src/runtime/tool-registry.ts:invoke per chiamare hook pre/post. Fail-open: se un hook lancia, loggare e continuare. Nessuna dipendenza nuova pesante.

## File references
- `packages/core/src/runtime/tool-registry.ts`
- `packages/core/src/runtime/lifecycle-hooks.ts`

## Acceptance criteria
- invoke() chiama pre-hook prima dell'esecuzione e post-hook dopo
- Eccezione in hook non blocca il tool call (try/catch con log)
- Hook registry riceve eventi via EventEmitter esistente o wrapper equivalente

## QA scenario

Test integrazione: invocare tool che lancia in pre-hook → tool call viene comunque eseguito, audit log contiene l'errore dell'hook.
