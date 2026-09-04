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
| [docs/GUIDA.md](./docs/GUIDA.md) | Full Italian user guide |
| [docs/TOOLS.md](./docs/TOOLS.md) | Tool / skill map |
| [SECURITY.md](./SECURITY.md) | Vulnerability reporting |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

`HANDOFF.md`, `HANDOFF-kraken.md`, `HANDOFF-v0.10.0.md` and `docs/plans/*` are **historical / superseded** and not required reading for new contributors. Current product state (1.35.x): `CHANGELOG.md` + `docs/GUIDA.md`.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the **Apache License 2.0** (see [LICENSE](./LICENSE)). Copyright holder: Anathema Studio — https://anathema-studio.com/
