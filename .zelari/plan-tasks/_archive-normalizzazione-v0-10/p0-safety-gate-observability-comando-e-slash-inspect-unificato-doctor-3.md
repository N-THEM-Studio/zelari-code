---
kind: task
id: p0-safety-gate-observability-comando-e-slash-inspect-unificato-doctor-3
phaseId: p0-safety-gate-observability
status: pending
priority: high
tags: [src/cli/commands/inspect.ts, src/cli/utils/doctor.ts, src/cli/slash/inspect.ts]
---
# Comando e slash /inspect unificato (≠ doctor)

Nuovo modulo inspect runtime: sezioni trust, hooks, mcp, skills, plugins, phase/mode. Output human + --json con schema versioned. doctor resta install-only (bin/PATH/Node). Allineare help strings per non confondere.

## File references
- `src/cli/commands/inspect.ts`
- `src/cli/utils/doctor.ts`
- `src/cli/slash/inspect.ts`

## Acceptance criteria
- inspect elenca trust+hooks+mcp+skills+plugins
- --json ha campo version stabile
- doctor non include sezioni runtime hooks
- Stesso report consumabile da Desktop X-Ray

## QA scenario

Esegui doctor e inspect --json; verifica sezioni disgiunte; JSON parseabile CI.
