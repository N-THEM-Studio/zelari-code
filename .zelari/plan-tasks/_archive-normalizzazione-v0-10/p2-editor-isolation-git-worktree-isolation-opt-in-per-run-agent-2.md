---
kind: task
id: p2-editor-isolation-git-worktree-isolation-opt-in-per-run-agent-2
phaseId: p2-editor-isolation
status: pending
priority: low
tags: [src/cli/gitOps.ts, src/cli/runHeadless.ts, src/cli/main.ts, src/cli/workspace/paths.ts]
---
# Git worktree isolation opt-in per run agent

Flag --worktree crea worktree git temporaneo, cwd harness = worktree, cleanup a fine run. Default off. Nessun btrfs CoW.

## File references
- `src/cli/gitOps.ts`
- `src/cli/runHeadless.ts`
- `src/cli/main.ts`
- `src/cli/workspace/paths.ts`

## Acceptance criteria
- --worktree isola edit in path worktree
- Exit cleanup rimuove worktree se --worktree-cleanup
- Repo non-git → errore chiaro, no crash

## QA scenario

Run headless con edit_file in worktree; main tree invariato finché non merge manuale.
