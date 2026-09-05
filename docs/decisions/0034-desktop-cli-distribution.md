# ADR-0034: Desktop ships the same contract (guided CLI install first, bundling deferred)

- **Status:** accepted (identity wave)
- **Date:** 2026-09-02
- **Principles:** P3 (sovereignty - same visible contract on every surface), P6 (right orchestration), P1 (the proof the user sees is the product)

## Context

The Desktop app (Tauri 2) spawns the CLI in `--headless` mode. Today it *finds*
a CLI if one exists on PATH or via `ZELARI_CLI_PATH` (`apps/desktop/src-tauri/src/lib.rs`,
CLI resolver), but it never installs or updates one, and the Desktop UI does not
surface the same status contract the TUI now shows (Phase / Mode / Verification /
Permissions). Two products with two different stories is an identity hole: the user
cannot tell whether Zelari *saw* or just *said*.

Options:

- **(a) Bundle the CLI as a Tauri sidecar** (`externalBin`, version pinned to
  the app). Pros: zero-setup Desktop. Cons: version skew with the npm CLI,
  double update channels, larger downloads, and every CLI release forces a
  Desktop release.
- **(b) Guided install + health check + update button** on top of the existing
  resolver. Pros: one distribution channel (npm), the resolver already works,
  the app stays thin. Cons: first-run requires npm.

## Decision

1. **Now - option (b).** Desktop keeps resolving the CLI and adds a first-run
   guided flow: if no CLI is found, the app shows the exact command
   (`npm install -g zelari-code`), then health-checks it via
   `zelari-code --doctor`-equivalent probes, and offers an "update CLI" action
   (`npm install -g zelari-code@latest`).
2. **Now - same contract chips.** The Desktop status strip derives the four
   chips (Phase, Mode, Verification `prova: PASS|RIPARA|BLOCCATO`, Permissions) from
   the sidecar events/spine - the same projection the TUI StatusBar uses
   (`src/cli/kraken/verifyStatus.ts` is the single source of the mapping, so
   the two surfaces cannot disagree).
3. **Later - option (a) only if** first-run friction measurably blocks
   adoption; it would be a separate ADR with a version-skew policy.

## Consequences

- One pitch, one proof vocabulary, one distribution channel.
- `verifyStatus.ts` becomes a shared contract module: changing the verdict
  vocabulary requires updating both surfaces at once (intentional friction).
- Bundling remains an open, deliberately deferred option - not a silent
  promise.

## Alternatives considered

- Do nothing (two products, zero identity) - rejected: contradicts the
  identity wave and P3.
- Bundle now - rejected for now: version-skew and release-cadence costs before
  Desktop has measurable first-run drop-off.