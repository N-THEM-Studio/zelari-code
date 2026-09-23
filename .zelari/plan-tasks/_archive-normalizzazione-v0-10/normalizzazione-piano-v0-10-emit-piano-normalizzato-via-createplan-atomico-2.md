---
kind: task
id: normalizzazione-piano-v0-10-emit-piano-normalizzato-via-createplan-atomico-2
phaseId: normalizzazione-piano-v0-10
status: pending
priority: critical
tags: [.zelari/plan.json]
---
# Emit piano normalizzato via createPlan atomico

Un singolo createPlan che sovrascrive plan.json con la sequenza unificata P0 (HookRunner + fail-open audit) + P0.5 (provider failover composer-2.5 + replay deterministico). P2 descopato.

## File references
- `.zelari/plan.json`

## Acceptance criteria
- plan.json contiene esattamente 4 fasi e 1 milestone v0.10.0
- Nessuna fase con tag 'mode-auto' o scope P2
- Milestone targetVersion = 'v0.10.0' con exit criteria misurabili

## QA scenario

Leggere plan.json dopo emit: contare fasi = 4, milestone = 1. Grep 'mode-auto' deve restituire 0 match.
