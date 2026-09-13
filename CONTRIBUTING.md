# Contributing to Zelari Code

Maintained by **[Anathema Studio](https://anathema-studio.com/)**.

Thanks for your interest in contributing. This monorepo ships:

| Package | Path | Role |
|---------|------|------|
| `zelari-code` | repo root / `src/cli` | CLI + Ink TUI + headless entry |
| `@zelari/core` | `packages/core` | Apache-2.0 library: `AgentHarness`, council, skills, tools |
| `@zelari/desktop` | `apps/desktop` | Optional Tauri 2 shell (spawns CLI `--headless`) |
| companion | `apps/companion-android` | Thin Android client for `zelari-code serve` |

## Prerequisites

- **Node.js ≥ 24**
- **npm ≥ 11.7** (the workspace lockfile is pinned for this resolver line)
- **Git** (and on Windows, **Git Bash** for the agent `bash` tool)
- Optional: Rust + Tauri deps only if you touch Desktop

## Setup

```bash
git clone https://github.com/N-THEM-Studio/zelari-code.git
cd zelari-code
npm install
npm run build          # @zelari/core + CLI bundle
npm test
npm run typecheck
npm run smoke          # zelari-code --version
```

Local CLI without global install:

```bash
npm link
# or
node bin/zelari-code.js --doctor
```

Desktop (optional):

```bash
npm run desktop:install
npm run desktop:dev
```

## Project conventions

Aligned with `AGENTS.MD` / team defaults:

- **Async-first** — do not block the event loop
- **Zod** for LLM tool argument schemas
- Prefer **one tool definition per file** under builtin tool dirs
- Avoid new heavy deps (lodash, immer, …) — prefer the standard library
- Prefer new modules **≤ ~300 LOC**
- **Atomic commits** — one logical change per commit when practical

### Public API (`@zelari/core`)

Only the package `exports` map is public. See `packages/core/package.json` and [docs/decisions/0004-public-api-stability-policy.md](./docs/decisions/0004-public-api-stability-policy.md). Prefer importing subpaths (`@zelari/core/harness`, `@zelari/core/council`, …) over deep internal paths.

### Layout quick map

```
src/cli/                   # TUI, providers, registry, workspace, headless, serve
packages/core/src/         # AgentHarness, council, roles, 26 skills
apps/desktop/              # Tauri 2 UI
apps/companion-android/    # Android thin client
tests/unit/                # Vitest
docs/                      # User guide (IT), tools map, ADRs
docs/plans/                # Historical design notes (may be outdated)
```

## Pull requests

1. Fork / branch from `main`.
2. Keep changes focused; match existing style.
3. Add or update unit tests when behavior changes.
4. Run `npm test` and `npm run typecheck` before opening a PR.
5. Update docs when you change user-facing behavior (`README.md`, `docs/GUIDA.md`, `docs/TOOLS.md`, `CHANGELOG.md`).
6. Do not commit secrets, API keys, `apps/desktop/keys/`, local `mcps/`, or `.zelari/` workspaces.
7. **Identity check** — in the PR description, answer in one line: *which principle (P1–P6, see [`PRINCIPLES.md`](./PRINCIPLES.md)) makes this change more Zelari, and what did you reject because it was only "more like Claude Code"?* If the answer is "smoother UX" with no principle behind it, it is cosmetics — say so and keep it out.

## Documentation

| Doc | Audience |
|-----|----------|
| [Product page](https://anathema-studio.com/zelari-code) | Marketing + install CTAs |
| [README.md](./README.md) | English landing + install |
| [docs/GUIDA.md](./docs/GUIDA.md) | Full user guide (English) |
| [docs/TOOLS.md](./docs/TOOLS.md) | Tool / skill map |
| [SECURITY.md](./SECURITY.md) | Vulnerability reporting |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

`HANDOFF.md`, `HANDOFF-kraken.md`, `HANDOFF-v0.10.0.md` and `docs/plans/*` are **historical / superseded** and not required reading for new contributors. Current product state: `CHANGELOG.md` + `docs/GUIDA.md` — no version is pinned in this file (the changelog is the source of truth). Release cadence: at most one minor per 48h; batch smaller fixes into patch releases.

## Releases (tag → npm + desktop)

Releases are **tag-driven**: `publish.yml` (npm `zelari-code` + `@zelari/core` + GitHub Release) and `release-desktop.yml` (3-platform installers + auto-update manifest) trigger only on `v*.*.*` tags. Procedure:

1. Bump **every lockstep point**, not just the four package manifests:
   - `package.json` × 3 (root, `packages/core`, `apps/desktop`) + `apps/desktop/src-tauri/tauri.conf.json`
   - `apps/desktop/src-tauri/Cargo.toml` + `Cargo.lock` (desktop version)
   - root devDependency pin `"@zelari/core": "x.y.z"` (exact match)
   - `CORE_VERSION` in `packages/core/src/version.ts` (guarded by `publicApi.contract.test.ts` — the publish workflow runs it)
   - `CHANGELOG.md` entry + any version callouts in `docs/GUIDA.md`, `README.md`, core README
2. **Run `npm run verify:versions` locally, on the exact commit you are about to tag.** This gate lives in the merge CI (`ci.yml`), NOT in the publish workflow — a green publish run does not prove version coherence. Skipping this ships a tag that turns `main` CI red minutes after npm publish.
3. Push `main` first, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Release workflows check out the tag ref at runtime, so the tagged commit must be the coherent one already on `main`.
4. Watch both release workflows; treat `npm view <pkg> version` as the authority (registry CDN may lag minutes behind a green publish). npm unpublish is effectively one-way — **fix forward** on `main` and re-tag only while nothing has been published yet.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the **Apache License 2.0** (see [LICENSE](./LICENSE)). Copyright holder: Anathema Studio — https://anathema-studio.com/

## Freeze delle superfici (S0 — piano 2.37, M1 prima di tutto)

Fino a chiusura della fase M1 (morsa sul done) ogni PR deve dichiarare una label:

- `done-gate` — chiude R0/R4b: evidence meccanica sul verdetto (pack nativo, no pattern B, exit 4).
- `spine` — single-write/session spine. Richiede anche: "il modello vede solo la Session" (o un test che lo provi).
- `mission` — slice-from-plan / resume-mission.
- `surface` — tutto il resto (Desktop chrome, nuovi provider/transport, ruoli council, widget). **Richiede un'exception scritta nel body della PR** che motivi il P0 che copre.

Regola di triage per PR fuori piano: *quale criterio P1-P6 o quale residuo chiude?* Se la risposta e "UX" o "parity", slitta.

Gate merge (in ordine): `npm run verify:principles` -> `npm run verify:versions` -> build core -> `tsc --noEmit` -> `npm run test:session` -> test morsa M1 (`src/cli/kraken/*.test.ts`) -> (se aperte) mission e2e.

Escapes: i bug P0 (break turn, evidenza falsa, version drift, fail-open permessi) passano sempre; `--allow-unverified` e l'opt-out `ZELARI_VERIFY_PACK=0` sono opzioni utente, non deroghe di sviluppo.
