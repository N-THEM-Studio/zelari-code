---
kind: task
id: p2-editor-isolation-scheduler-loop-headless-leggero-3
phaseId: p2-editor-isolation
status: pending
priority: low
tags: [src/cli/runHeadless.ts, src/cli/headless.ts, src/cli/main.ts, src/cli/zelariMission.ts]
---
# Scheduler /loop headless leggero

zelari-code loop --every Ns --task '…' ripete headless single-agent con budget max-runs e stop on fail. Non cron daemon OS.

## File references
- `src/cli/runHeadless.ts`
- `src/cli/headless.ts`
- `src/cli/main.ts`
- `src/cli/zelariMission.ts`

## Acceptance criteria
- --max-runs 3 esegue ≤3 iterazioni
- Exit non-zero su fail se --stop-on-fail
- Documentato come experimental

## QA scenario

loop --every 1 --max-runs 2 --task 'echo ok' (bash) completa 2 cicli e esce 0.
