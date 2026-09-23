---
kind: task
id: implementazione-p0-lifecyclehookrunner-fail-open-audit-log-su-file-2
phaseId: implementazione-p0-lifecyclehookrunner
status: pending
priority: high
tags: [packages/core/src/runtime/audit.ts, .gitignore]
---
# Fail-open audit log su file

Persistenza append-only di ogni hook fire su .zelari/audit/hooks.log (gitignored). Formato JSONL: timestamp, hookId, tool, phase, outcome, error?.

## File references
- `packages/core/src/runtime/audit.ts`
- `.gitignore`

## Acceptance criteria
- File .zelari/audit/hooks.log creato al primo fire
- Ogni riga è JSON valido con i campi attesi
- .gitignore contiene .zelari/audit/

## QA scenario

Lanciare 3 invocazioni consecutive: `wc -l .zelari/audit/hooks.log` deve restituire ≥3, `jq .` deve validare ogni riga.
