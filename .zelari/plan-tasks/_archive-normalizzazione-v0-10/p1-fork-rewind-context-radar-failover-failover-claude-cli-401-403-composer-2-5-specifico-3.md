---
kind: task
id: p1-fork-rewind-context-radar-failover-failover-claude-cli-401-403-composer-2-5-specifico-3
phaseId: p1-fork-rewind-context-radar-failover
status: pending
priority: high
tags: [src/cli/crossProviderFailover.ts, packages/core/src/core/tools/auditLog.ts, tests/unit/crossProviderFailover-auth.test.ts (nuovo)]
---
# Failover Claude CLI 401/403 → composer-2.5 (specifico)

Estendere src/cli/crossProviderFailover.ts: match specifico status 401/403 + provider 'claude-cli' → fallback 'composer-2.5' (NON generico). Loggare in auditLog.ts con reason:'auth'. Test: crossProviderFailover-auth.test.ts (match 401/403 claude-cli, no-match altri provider, no-match altri status).

## File references
- `src/cli/crossProviderFailover.ts`
- `packages/core/src/core/tools/auditLog.ts`
- `tests/unit/crossProviderFailover-auth.test.ts (nuovo)`

## Acceptance criteria
- Claude CLI + 401 → fallback composer-2.5 con audit log
- Claude CLI + 403 → fallback composer-2.5 con audit log
- Claude CLI + 500 → nessun fallback (non auth)
- Altro provider + 401 → nessun fallback (non specifico)

## QA scenario

1. Mock provider Claude CLI che ritorna 401 → output usa composer-2.5. 2. Verifica auditLog contiene entry con reason:'auth'.
