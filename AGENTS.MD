# AGENTS.MD — zelari-code

> Auto-curated by Zelari Code council. Run `/council` to refresh.
> See `.zelari/` for raw decision log.

## Overview

**Zelari Code** — AI council coding agent CLI + `@zelari/core` + optional Tauri Desktop.  
Maintained by [Anathema Studio](https://anathema-studio.com/). Monorepo Apache-2.0. First principles: [`PRINCIPLES.md`](./PRINCIPLES.md) (P1–P6).  
User docs: `README.md`, `docs/GUIDA.md`, `docs/TOOLS.md`. Contribute: `CONTRIBUTING.md`.

## Tech Stack

<!-- zelari:auto:start section="tech-stack" -->
<!-- Auto-derived from package.json -->

**Runtime:**
- ink `^6.8.0`
- ink-text-input `^6.0.0`
- react `^19.2.7`
- zod `^4.4.3`

**Dev:**
- @types/node `^25.3.0`
- @types/react `^19.0.10`
- esbuild `^0.24.0`
- typescript `~5.7.2`
- vitest `^2.1.9`

<!-- zelari:auto:end section="tech-stack" -->

## Decisions

<!-- zelari:auto:start section="decisions" -->
See `docs/decisions/` for full ADRs (context/decision/consequences).

**Accepted:**
- **0016-event-sourced-session-log** _(accepted 2026-08-19)_ — session spine: append-only JSONL, single writer + ownership lock, monotonic `seq`, `SCHEMA_VERSION`, tolerant replay, `deriveMessages` as the only model-history path. Location: `.zelari/sessions/` (env `ZELARI_SESSIONS_DIR`).
- **0021-session-spine-contract** _(accepted)_ — public contract of the spine v1 (envelope, writer, replay, projection, lineage, export).
- **0022-execution-seams-profiles** _(accepted)_ — WorkspaceProvider/FsProvider/ShellProvider/SubagentProvider seams + versioned profiles (`minimal/v1`, `kraken/v1`, `council/v1`, `mission/v1`).
- **0023-deterministic-verification-completion** _(accepted)_ — Criterion/EvidenceRef/VerificationResult evidence contract, `unknown ≠ pass`, CompletionPolicy `PASS|REPAIR_REQUIRED|BLOCKED`, criteria pack v1, VerifierService advisory-only.
- **0024-single-write-model-context** _(accepted 2026-08-19, amended 2026-08-30)_ — the spine is the only model-context source on every headless host + TUI; the amendment adds the graph host (`runHeadlessKrakenGraph`, `src/cli/runHeadless.ts`) to the spine hot paths with envelope-only coverage in v1 (`started` / `user.message` / `ended`; per-node events and inner turns stay off the spine).
- **0025-strict-done-defaults** _(accepted 2026-08-20)_ — strict done defaults per surface: Kraken opt-in, mission ON, Desktop aligned with the CLI (`DEFAULT_DESKTOP_PREFS.strictDone = true`).
- **0031-recall-asymmetry-single-agent** _(accepted 2026-08-30)_ — recall asymmetry on single-agent paths is deliberate: default-off, opt-in only through the measurable `context.projection` gate (promoted from `.zelari/decisions/014`).
- **0032-budget-pipeline-canonical-projection** _(accepted 2026-08-30)_ — the CLI budget pipeline is the canonical projection compiler; `ContextProjector` stays tentacle parent-context only and HarnessState is a read-model (promoted from `.zelari/decisions/015`).
- **011-windows-path-auto-fix** _(accepted)_ — Auto-fix the npm global prefix missing from the user PATH on Windows, both at install time (`scripts/postinstall.mjs` → `scripts/repair-path.mjs`) and at runtime (`zelari-code --fix-path` → `src/cli/utils/fixPath.ts`). Scope is HKCU ("User"), never HKLM; idempotent exact-entry match; opt-out via `ZELARI_NO_PATH_REPAIR=1`. `zelari-code --doctor` now points users at `--fix-path`. Residual limits: GPO PATH resets, SYSTEM-scope installs, and non-standard node managers (nvm-windows/scoop/volta) remain out of reach.

<!-- zelari:auto:end section="decisions" -->

## Conventions

<!-- zelari:auto:start section="conventions" -->
<!-- Zelari Code defaults -->

- One tool definition per file in `packages/core/src/core/tools/builtin/` (CLI factories in `src/cli/tools/`)
- Async-first; never block the event loop
- Zod schemas for all LLM tool args
- Single-task atomic commits; no batching
- Zero new heavy deps (lodash, immer, etc.) — use std lib
- Files ≤ 300 LOC preferred for new modules

<!-- zelari:auto:end section="conventions" -->

## Build

<!-- zelari:auto:start section="build" -->
<!-- Auto-derived from package.json scripts -->

`npm run build` — tsc -p tsconfig.json && node scripts/bundle-cli.mjs
`npm run build:cli` — tsc -p tsconfig.json && node scripts/bundle-cli.mjs
`npm run prepublishOnly` — node scripts/prepublish.mjs
`npm run smoke` — node bin/zelari-code.js --version
`npm run test` — vitest run
`npm run verify:principles` — node scripts/verify-principles.mjs
`npm run verify:versions` — node scripts/verify-versions.mjs
`npm run test:watch` — vitest
`npm run typecheck` — npm run build --workspace=@zelari/core && tsc --noEmit -p tsconfig.json

<!-- zelari:auto:end section="build" -->

## Open Questions

<!-- zelari:auto:start section="open-questions" -->
_No open questions._
<!-- zelari:auto:end section="open-questions" -->
