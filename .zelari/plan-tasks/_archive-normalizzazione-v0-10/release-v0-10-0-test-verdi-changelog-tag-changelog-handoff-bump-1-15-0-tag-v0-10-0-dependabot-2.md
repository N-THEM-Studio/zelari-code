---
kind: task
id: release-v0-10-0-test-verdi-changelog-tag-changelog-handoff-bump-1-15-0-tag-v0-10-0-dependabot-2
phaseId: release-v0-10-0-test-verdi-changelog-tag
status: pending
priority: critical
tags: [CHANGELOG.md, HANDOFF-v0.10.0.md, package.json (bump version), .github/dependabot.yml (verifica config)]
---
# CHANGELOG + HANDOFF + bump 1.15.0 + tag v0.10.0 + Dependabot

Aggiungere sezione '## v0.10.0 (1.15.0) — YYYY-MM-DD' in CHANGELOG.md con Added (LifecycleHookRunner, FolderTrustStore, /inspect, TrustBadge, X-Ray), Changed (alias Claude/Cursor estesa), Security (gate trust + fail-open audit). Spostare voci da [Unreleased]. Aggiornare HANDOFF-v0.10.0.md con scope shipped, descoped (councilApi refactor → v0.11.0), link file chiave. Bump package.json 1.14.4→1.15.0. Triage Dependabot critical (issue con security: label o fix mergiato). git tag -a v0.10.0 + git push origin v0.10.0.

## File references
- `CHANGELOG.md`
- `HANDOFF-v0.10.0.md`
- `package.json (bump version)`
- `.github/dependabot.yml (verifica config)`

## Acceptance criteria
- CHANGELOG.md contiene sezione v0.10.0 completa
- HANDOFF-v0.10.0.md riflette scope finale shipped/descoped
- package.json version=1.15.0
- Tag v0.10.0 pushed su origin
- Dependabot critical triagiato (issue aperte o fix chiuso)

## QA scenario

1. jq '.version' package.json → '1.15.0'. 2. git tag --list | grep v0.10.0 → 'v0.10.0'. 3. git ls-remote --tags origin | grep v0.10.0 → presente.
