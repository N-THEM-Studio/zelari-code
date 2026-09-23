---
kind: task
id: p2-integrazione-editor-isolamento-git-worktree-isolation-per-run-agent-2
phaseId: p2-integrazione-editor-isolamento
status: pending
priority: low
tags: [src/cli/branchManager.ts, src/cli/gitOps.ts, src/cli/main.ts]
---
# Git worktree isolation per run agent

Opzione --worktree: crea worktree git dedicato, esegue agent lì, report path. No btrfs CoW in v1.

## File references
- `src/cli/branchManager.ts`
- `src/cli/gitOps.ts`
- `src/cli/main.ts`

## Acceptance criteria
- --worktree non sporca working tree principale
- Cleanup documentato o flag --keep-worktree

## QA scenario

Run headless con --worktree che crea file; main tree clean.
