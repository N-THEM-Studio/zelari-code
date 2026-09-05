# `@zelari/core`

Reusable runtime for [Zelari Code](https://github.com/N-THEM-Studio/zelari-code) — **Apache-2.0**.

Current version: **2.33.0** (kept in lockstep with the `zelari-code` CLI).

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

### API stability tiers (2.30, t53)

| Subpath | Tier | Semver effect |
|---|---|---|
| `@zelari/core/harness` (`AgentHarness`) | **Stable** | breaking only on major |
| `@zelari/core/harness/tools` (`ToolRegistry` + default tools) | **Stable** | breaking only on major (incl. the `…/registry` deep subpath) |
| `@zelari/core/runtime` — seams, profiles, `resourcePolicy`/budget ledger types | **Stable** | breaking only on major |
| `@zelari/core/runtime` — `observers`, `guards`, `recorder`, `controls` | **Experimental** | may change on minor |
| `@zelari/core/session`, `/context`, `/verification` | **Stable** | spine contract (ADR-0021/0024) |
| `@zelari/core/mission`, `/events`, `/state` | **Experimental** | may change on minor |

**Semver policy for exports:**

- The `exports` map in `package.json` IS the contract: removing a subpath, or
  removing a type from a **Stable** barrel, is a breaking change → major bump.
- New subpaths and additive exports are minor releases.
- **Experimental** surfaces may change within a minor; pin the exact version if
  you depend on them.
- Core versions are lockstep with the CLI (`verify-versions` gate); `CORE_VERSION`
  never moves independently of a CLI release.

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
