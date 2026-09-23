---
kind: task
id: p0-5-ship-milestone-v0-10-0-ship-v0-10-0-changelog-dependabot-critical-3
phaseId: p0-5-ship-milestone-v0-10-0
status: pending
priority: critical
tags: [CHANGELOG.md, HANDOFF.md, package.json]
---
# Ship v0.10.0: CHANGELOG + dependabot critical

Aggiornare CHANGELOG.md con tutte le feature P0+P0.5, chiudere la dipendenza critical Dependabot, tag git v0.10.0, aggiornare HANDOFF.md con data ship.

## File references
- `CHANGELOG.md`
- `HANDOFF.md`
- `package.json`

## Acceptance criteria
- CHANGELOG.md ha sezione v0.10.0 con elenco feature P0+P0.5
- Dependabot critical alert chiuso (PR mergiato o dismissed con motivazione)
- Tag v0.10.0 esiste localmente e in remote

## QA scenario

`git tag -l | grep v0.10.0` → 1 match. `cat CHANGELOG.md | grep '## v0.10.0'` → 1 match.
