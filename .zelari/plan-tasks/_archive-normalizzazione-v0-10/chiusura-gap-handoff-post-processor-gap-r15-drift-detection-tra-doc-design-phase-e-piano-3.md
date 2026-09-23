---
kind: task
id: chiusura-gap-handoff-post-processor-gap-r15-drift-detection-tra-doc-design-phase-e-piano-3
phaseId: chiusura-gap-handoff-post-processor
status: pending
priority: medium
tags: [.zelari/risks.json, docs/customer-journey-map.md, docs/information-architecture.md, docs/design-tokens.md]
---
# Gap R15: drift detection tra doc design-phase e piano

Aggiungere al registry risks la entry R15: 'doc design-phase (customer-journey, IA, tokens) emessi 2026-07-16 non ri-emessi ad ogni plan change → drift risk'. Mitigazione: link bidirezionale doc↔piano via linkDocuments.

## File references
- `.zelari/risks.json`
- `docs/customer-journey-map.md`
- `docs/information-architecture.md`
- `docs/design-tokens.md`

## Acceptance criteria
- R15 presente in risks.json con mitigation concreta
- Ogni doc design-phase ha frontmatter `related:` che punta a plan.json
- grep reciproco doc↔plan restituisce match

## QA scenario

grep 'related' docs/customer-journey-map.md deve mostrare riferimento a .zelari/plan.json.
