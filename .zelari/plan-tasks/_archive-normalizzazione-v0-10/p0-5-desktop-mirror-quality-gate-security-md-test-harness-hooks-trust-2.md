---
kind: task
id: p0-5-desktop-mirror-quality-gate-security-md-test-harness-hooks-trust-2
phaseId: p0-5-desktop-mirror-quality-gate
status: pending
priority: high
tags: [SECURITY.md, tests/unit, packages/core/src/core/hooks]
---
# SECURITY.md + test harness hooks/trust

Estendere SECURITY.md: hooks come superficie RCE, folder trust, kill-switch, reporting. Suite Vitest: deny, fail-open, untrusted no-spawn, path canonicalize.

## File references
- `SECURITY.md`
- `tests/unit`
- `packages/core/src/core/hooks`

## Acceptance criteria
- SECURITY.md menziona hooks RCE + trust + ZELARI_FOLDER_TRUST
- Vitest copre deny, fail-open, untrusted no-spawn
- Nessuna dipendenza grok-build in package-lock

## QA scenario

npm test passa; grep SECURITY per hooks e trust; lockfile senza xai-grok.
