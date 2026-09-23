---
kind: task
id: p0-parit-sicurezza-osservabilit-comando-inspect-unificato-3
phaseId: p0-parit-sicurezza-osservabilit
status: pending
priority: high
tags: [src/cli/main.ts, src/cli/utils/doctor.ts]
---
# Comando inspect unificato

CLI `zelari-code inspect [--json]` che elenca config sources, skills, MCP, hooks, plugins, AGENTS.md rules, phase/mode.

## File references
- `src/cli/main.ts`
- `src/cli/utils/doctor.ts`

## Acceptance criteria
- Output human-readable e --json machine-readable
- Include path e trust status per ogni hook/MCP progetto

## QA scenario

Eseguire inspect in un progetto misto e verificare sezioni non vuote per skills e MCP se presenti.
