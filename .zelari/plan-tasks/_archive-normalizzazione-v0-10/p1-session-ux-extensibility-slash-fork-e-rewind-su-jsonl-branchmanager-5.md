---
kind: task
id: p1-session-ux-extensibility-slash-fork-e-rewind-su-jsonl-branchmanager-5
phaseId: p1-session-ux-extensibility
status: pending
priority: high
tags: [src/cli/session, packages/core/src/core/sessionJsonl.ts, .zelari/decisions/003-session-time-travel-fork-rewind-su-jsonl-checkpoint.md]
---
# Slash /fork e /rewind su JSONL + branchManager

UX Grok-like: /fork crea branch sessione; /rewind N riposiziona transcript. Default rewind = history only; restore tree solo via checkpoint esplicito. Copy UI anti-confusione (R7).

## File references
- `src/cli/session`
- `packages/core/src/core/sessionJsonl.ts`
- `.zelari/decisions/003-session-time-travel-fork-rewind-su-jsonl-checkpoint.md`

## Acceptance criteria
- /fork crea branch sessione ispezionabile
- /rewind non modifica working tree di default
- Help/UI dice esplicitamente transcript-only
- Checkpoint resta comando separato

## QA scenario

Modifica file; /rewind 1; file su disco invariati; transcript indietro.
