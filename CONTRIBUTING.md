# Contributing to Zelari Code

Maintained by **[Anathema Studio](https://anathema-studio.com/)**.

Thanks for your interest in contributing. This monorepo ships:

| Package | Path | Role |
|---------|------|------|
| `zelari-code` | repo root / `src/cli` | CLI + Ink TUI + headless entry |
| `@zelari/core` | `packages/core` | MIT library: `AgentHarness`, council, skills, tools |
| `@zelari/desktop` | `apps/desktop` | Optional Tauri shell (spawns CLI `--headless`) |

## Prerequisites

- **Node.js ≥ 20**
- **npm ≥ 10**
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
src/cli/                 # TUI, providers, registry, workspace, headless
packages/core/src/       # AgentHarness, council, roles, skills
apps/desktop/            # Tauri UI
tests/unit/              # Vitest
docs/                    # User guide (IT), tools map, ADRs
docs/plans/              # Historical design notes (may be outdated)
```

## Pull requests

1. Fork / branch from `main`.
2. Keep changes focused; match existing style.
3. Add or update unit tests when behavior changes.
4. Run `npm test` and `npm run typecheck` before opening a PR.
5. Update docs when you change user-facing behavior (`README.md`, `docs/GUIDA.md`, `docs/TOOLS.md`, `CHANGELOG.md`).
6. Do not commit secrets, API keys, `apps/desktop/keys/`, local `mcps/`, or `.zelari/` workspaces.

## Documentation

| Doc | Audience |
|-----|----------|
| [Product page](https://anathema-studio.com/zelari-code) | Marketing + install CTAs |
| [README.md](./README.md) | English landing + install |
| [docs/GUIDA.md](./docs/GUIDA.md) | Full Italian user guide |
| [docs/TOOLS.md](./docs/TOOLS.md) | Tool / skill map |
| [SECURITY.md](./SECURITY.md) | Vulnerability reporting |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

`HANDOFF.md` and `docs/plans/*` are **historical** and not required reading for new contributors.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the **MIT License** (see [LICENSE](./LICENSE)). Copyright holder: Anathema Studio — https://anathema-studio.com/
