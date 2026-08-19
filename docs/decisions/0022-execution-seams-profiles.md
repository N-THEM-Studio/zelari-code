# ADR-0022 — Execution seams (WorkspaceProvider & friends) e profili versionati

**Status:** Accepted
**Date:** 2026-08-19

## Contesto

Il worktree Kraken è oggi un flag ambientale sparso (`ZELARI_KRAKEN_WORKTREE` in
`src/cli/tools/krakenWorktree.ts`); shell e fs sono raggiunti direttamente dai tool.
Il piano 2.0 chiede seam espliciti per isolamento, confrontabilità dei profili e
esperimenti futuri (remote sandbox) **senza** introdurre un plugin framework.

## Decisione

`@zelari/core/runtime` espone seam minimi, iniettati e jailati:

- **`WorkspaceProvider`** — `{kind: local|worktree|memory|remote, root, resolve(rel), dispose?()}`.
  `resolve` applica il path jail (errore `WorkspacePathEscapeError` fuori da root).
  `WorktreeWorkspace` implementa il worktree git (`zelari/worktree-<id>` sotto
  `.zelari/worktrees/`, create/diff/merge-squash/dispose) — la logica esistente del CLI
  convergerà su questo provider.
- **`FsProvider` / `ShellProvider`** — operazioni sempre relative al workspace;
  `NodeShellProvider` gira comandi con cwd jailato, timeout e cap output;
  implementazioni in-memory per i test deterministici.
- **`SubagentProvider`** — seam per la delega (`runTask`); in core esiste solo il
  no-op (available: false): l'iniezione reale avviene nel CLI (task tool path).
- **`ExecutionContext`** — bundle {session, workspace, fs, shell, subagent, profile,
  experimental} creato da `createExecutionContext`.
- **Profili versionati** — `Profile {id: <name>/v<N>, tools[], orchestration,
  verification}` con hash del manifest (`toolManifestHash`, sha256 dei tool ordinati):
  - `minimal/v1`: read_file, edit_file, bash, grep_content, list_files (baseline
    benchmark immutabile);
  - `kraken/v1`: orchestrazione completa + verification deterministica;
  - `council/v1`, `mission/v1` (metadata; mission completa in Fase 4).
- **Choke point invariato**: i provider sono raggiunti solo via `ToolRegistry.invoke`
  o dai servizi interni di verifica (SafeExecutionServices path). Nessun bypass P2.

## Alternative considerate

1. **Plugin framework generico** — rifiutato: P6 right-sizing; solo seams espliciti.
2. **Worktree nel CLI per sempre** — rifiutato: impedisce remote sandbox e test
   di isolamento deterministici in core.

## Conseguenze

**Positive** — parallelismo sicuro (worktree come policy path), benchmark
minimal-vs-kraken confrontabile, superficie per remote/E2B già disegnata.

**Negative** — doppio binario temporaneo CLI flag ↔ provider finché i tool critici
non migrano (migrazione dietro `ZELARI_SEAMS=1`, pianificata in Fase 2.9).
