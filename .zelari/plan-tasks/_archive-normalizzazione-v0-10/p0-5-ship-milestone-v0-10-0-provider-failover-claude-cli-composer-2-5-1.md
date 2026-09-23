---
kind: task
id: p0-5-ship-milestone-v0-10-0-provider-failover-claude-cli-composer-2-5-1
phaseId: p0-5-ship-milestone-v0-10-0
status: pending
priority: high
tags: [packages/core/src/providers/registry.ts, packages/core/src/providers/composer.ts]
---
# Provider failover: Claude CLI → composer-2.5

Implementare in provider-registry.ts: se Claude CLI ritorna 401/403, fallback automatico a composer-2.5 con log esplicito del motivo. Workaround ufficiale per HANDOFF #3.

## File references
- `packages/core/src/providers/registry.ts`
- `packages/core/src/providers/composer.ts`

## Acceptance criteria
- Mock test: Claude 401 → composer-2.5 invocato automaticamente
- Log contiene 'fallback reason=claude_401'
- Nessuna regressione su altri provider

## QA scenario

Test: forzare Claude CLI auth expired, chiamare council run → output deve menzionare fallback e completare senza errore utente.
