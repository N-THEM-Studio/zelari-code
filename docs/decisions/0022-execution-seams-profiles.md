# ADR-0022 - Execution seams (WorkspaceProvider & friends) and versioned profiles

**Status:** Accepted
**Date:** 2026-08-19

## Context

The Kraken worktree is today a scattered environmental flag (`ZELARI_KRAKEN_WORKTREE` in `src/cli/tools/krakenWorktree.ts`); shell and fs are reached directly by tools. The 2.0 plan asks for explicit seams for isolation, profile comparability and future experiments (remote sandbox) **without** introducing a plugin framework.

## Decision

`@zelari/core/runtime` exposes minimal, injected, jailed seams:

- **`WorkspaceProvider`** - `{kind: local|worktree|memory|remote, root, resolve(rel), dispose?()}`.
  `resolve` applies the path jail (`WorkspacePathEscapeError` outside root).
  `WorktreeWorkspace` implements the git worktree (`zelari/worktree-<id>` under `.zelari/worktrees/`, create/diff/merge-squash/dispose) - the CLI's existing logic will converge onto this provider.
- **`FsProvider` / `ShellProvider`** - operations always relative to the workspace;
  `NodeShellProvider` runs commands with a jailed cwd, timeout and output cap;
  in-memory implementations for deterministic tests.
- **`SubagentProvider`** - seam for delegation (`runTask`); in core only the no-op exists (available: false): the real injection happens in the CLI (task tool path).
- **`ExecutionContext`** - bundle {session, workspace, fs, shell, subagent, profile, experimental} created by `createExecutionContext`.
- **Versioned profiles** - `Profile {id: <name>/v<N>, tools[], orchestration, verification}` with a manifest hash (`toolManifestHash`, sha256 of the sorted tools):
  - `minimal/v1`: read_file, edit_file, bash, grep_content, list_files (immutable benchmark baseline);
  - `kraken/v1`: full orchestration + deterministic verification;
  - `council/v1`, `mission/v1` (metadata; full mission in Phase 4).
- **Choke point unchanged**: providers are reached only via `ToolRegistry.invoke` or by internal verification services (SafeExecutionServices path). No P2 bypass.

## Alternatives considered

1. **Generic plugin framework** - rejected: P6 right-sizing; explicit seams only.
2. **Worktree in the CLI forever** - rejected: it prevents remote sandbox and deterministic isolation tests in core.

## Consequences

**Positive** - safe parallelism (worktree as a policy path), comparable minimal-vs-kraken benchmark, a surface for remote/E2B already designed.

**Negative** - temporary dual track CLI flag <-> provider until the critical tools migrate (migration behind `ZELARI_SEAMS=1`, planned in Phase 2.9).