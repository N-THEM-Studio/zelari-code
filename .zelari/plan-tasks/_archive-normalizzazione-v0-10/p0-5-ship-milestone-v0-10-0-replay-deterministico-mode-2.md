---
kind: task
id: p0-5-ship-milestone-v0-10-0-replay-deterministico-mode-2
phaseId: p0-5-ship-milestone-v0-10-0
status: pending
priority: medium
tags: [src/cli/commands/replay.ts, packages/core/src/runtime/replay.ts]
---
# Replay deterministico mode

Flag --replay <session-id> che riesegue un run precedente usando .zelari/audit/hooks.log + snapshot dei tool results. Utile per debug e regression test.

## File references
- `src/cli/commands/replay.ts`
- `packages/core/src/runtime/replay.ts`

## Acceptance criteria
- Comando `zelari replay <id>` riesegue il run originale byte-equivalente sui tool calls
- Diff contro run originale ≤1% su output LLM (tolleranza per nondeterminism intrinseco)
- Documentato in README con esempio

## QA scenario

Run A → replay A → diff output salvato: differenze solo in campi timestamp/id, nessuna divergenza logica.
