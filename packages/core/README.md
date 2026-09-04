# `@zelari/core`

Reusable runtime for [Zelari Code](https://github.com/N-THEM-Studio/zelari-code) — **Apache-2.0**.

Current version: **2.30.0** (kept in lockstep with the `zelari-code` CLI).

## What it is

Provider-neutral **agent loop** (`AgentHarness`), **6-member council** orchestration, **26 built-in skills**, and filesystem/shell/search tool implementations. The CLI (`zelari-code`) is a consumer; other frontends can import the same library.

## Install

```bash
npm install @zelari/core
```

Requires **Node.js ≥ 24**. Runtime dependency: `zod` only.

## Public API

Only the `exports` map in `package.json` is public. Prefer curated subpaths over deep internals:

| Subpath | Contents |
|---------|----------|
| `@zelari/core` | Barrel (harness + council types) |
| `@zelari/core/harness` | `AgentHarness`, stream helpers, session JSONL |
| `@zelari/core/harness/tools` | `ToolRegistry` + schemas |
| `@zelari/core/council` | Council runner / roles |
| `@zelari/core/skills` | Skill definitions |
| `@zelari/core/memory` | `MemoryBackend` interface (file backend lives in the CLI) |

Stability policy: [docs/decisions/0004-public-api-stability-policy.md](../../docs/decisions/0004-public-api-stability-policy.md).

If you still import pre-0.5.0 `src/main/core/…` paths, see [MIGRATION.md](../../MIGRATION.md).

## Not in this package

Ink TUI, provider OAuth, Desktop, `zelari-code serve`, MCP host, SSH targets — those live in the CLI (`src/cli/`) and `apps/`.

## Develop (monorepo)

From the repo root:

```bash
npm install
npm run build --workspace=@zelari/core
npm test
```

## License

Apache-2.0 © [Anathema Studio](https://anathema-studio.com/).
