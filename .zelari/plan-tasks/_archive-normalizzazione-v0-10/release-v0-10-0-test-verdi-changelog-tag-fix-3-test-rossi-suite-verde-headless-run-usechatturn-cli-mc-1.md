---
kind: task
id: release-v0-10-0-test-verdi-changelog-tag-fix-3-test-rossi-suite-verde-headless-run-usechatturn-cli-mc-1
phaseId: release-v0-10-0-test-verdi-changelog-tag
status: pending
priority: critical
tags: [tests/unit/headless-run.test.ts, tests/unit/cli-useChatTurn.test.ts, tests/unit/cli-mcp.test.ts, tests/__setup__/hooks.ts (nuovo stub), src/cli/headless.ts (init latency)]
---
# Fix 3 test rossi + suite verde (headless-run, useChatTurn, cli-mcp)

Tre file rossi: tests/unit/headless-run.test.ts (timeout: aumentare timeoutMs test a 20s o ridurre latenza init headless.ts); tests/unit/cli-useChatTurn.test.ts (11 errori 'risultato hook nullo': creare stub LifecycleHookRunner in tests/__setup__/hooks.ts che l'hook runner in registry risolva); tests/unit/cli-mcp.test.ts (3 errori: isolare con vi.mock('../cli/mcp/catalog.js', () => ({ default: [] }))). Vincolo: npm run typecheck && npm test deve essere verde prima del tag (154 file, 1536+15 test tutti verdi).

## File references
- `tests/unit/headless-run.test.ts`
- `tests/unit/cli-useChatTurn.test.ts`
- `tests/unit/cli-mcp.test.ts`
- `tests/__setup__/hooks.ts (nuovo stub)`
- `src/cli/headless.ts (init latency)`

## Acceptance criteria
- npm run typecheck exit 0
- npm test → 0 failed (tutti i 154 file, 1536+15 test verdi)
- Nessun test 'risultato hook nullo' residuo

## QA scenario

1. npm run typecheck → exit 0. 2. npm test 2>&1 | tail -30 → 'Test Files 154 passed (154)' 'Tests 1551 passed (1551)'.
