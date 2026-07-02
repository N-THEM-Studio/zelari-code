# Migration guide — zelari-code v0.5.0

This guide covers the **only** breaking change in v0.5.0: the move
from internal `src/...` paths to the published **`@zelari/core`**
package.

If you only use `zelari-code` as a CLI (no `import` statements in your
own code), nothing changes for you — just run `zelari-code` as before.

## TL;DR

- If you imported core code from internal paths, change the path.
- There is **no compatibility shim**. Old paths will not work.
- All 9 subpath exports are listed in the table below.

## Why

Pre-v0.5.0, `@zelari/core` lived at `src/main/core/`, `src/agents/`,
`src/shared/`, `src/types/` — paths that were only ever intended as
in-repo locations. Publishing them as-is would have leaked internal
file structure to npm consumers, which is the wrong abstraction.

v0.5.0 extracts the core into a real npm workspace package
(`packages/core/`) and exposes **9 curated subpath exports**. The
rationale lives in
[`docs/decisions/0001-monorepo-for-zelari-core.md`](docs/decisions/0001-monorepo-for-zelari-core.md)
and
[`docs/decisions/0004-public-api-stability-policy.md`](docs/decisions/0004-public-api-stability-policy.md).

## Old → new import paths

| Old path (≤ 0.4.x)                    | New subpath                          | What's in it                                   |
|---------------------------------------|--------------------------------------|------------------------------------------------|
| `src/main/core/AgentHarness`          | `@zelari/core/harness`               | `AgentHarness` class, `ProviderStreamFn` type  |
| `src/main/core/providerStream`        | `@zelari/core/harness`               | provider stream helpers                        |
| `src/main/core/sessionJsonl`          | `@zelari/core/harness`               | `SessionJsonlWriter`                           |
| `src/main/core/tools`                 | `@zelari/core/harness/tools`         | `ToolRegistry`, schema types                   |
| `src/main/core/tools/builtin/*`       | `@zelari/core/harness/tools/builtin/*` | built-in tool implementations                |
| `src/agents/councilApi`               | `@zelari/core/council`               | `dispatchCouncil`, `runCouncilPure`            |
| `src/agents/roles`                    | `@zelari/core/council`               | the 6-member council role definitions          |
| `src/agents/promoteMember`            | `@zelari/core/council`               | `promoteMember` helper                         |
| `src/agents/skills`                   | `@zelari/core/skills`                | `SkillRegistry` and friends                    |
| `src/agents/skills/builtin/*`         | `@zelari/core/skills/builtin/*`      | built-in skill implementations                 |
| `src/agents/systemPromptBuilder`      | `@zelari/core/council` (use carefully — internal) | system prompt composition logic     |
| `src/agents/toolSchemas`              | `@zelari/core/harness/tools`         | JSON Schema helpers for tool definitions       |
| `src/agents/tools`                    | `@zelari/core/harness/tools`         | tool execution helpers                         |
| `src/shared/eventBus`                 | `@zelari/core/events`                | event bus primitives                           |
| `src/shared/events`                   | `@zelari/core/events`                | event type definitions                         |
| `src/types/context`                   | `@zelari/core/types`                 | session/context types                          |
| `src/types/knowledge`                 | `@zelari/core/types`                 | (was internal — surface area may change)       |
| `src/types/systemTypes`               | `@zelari/core/types`                 | system message types                           |

> ℹ️  Subpaths not on this table are **not part of the public API**.
> They may move, rename, or disappear in any minor release. If a
> symbol you need isn't on this table, open a feature request.

## Before / after examples

### A. Building a custom agent loop

```diff
- import { AgentHarness } from '../../src/main/core/AgentHarness.js';
- import type { ProviderStreamFn } from '../../src/main/core/providerStream.js';
+ import { AgentHarness, type ProviderStreamFn } from '@zelari/core/harness';
```

### B. Reading council events

```diff
- import { dispatchCouncil } from '../../src/agents/councilApi.js';
- import type { CouncilMember } from '../../src/agents/roles.js';
+ import { dispatchCouncil, type CouncilMember } from '@zelari/core/council';
```

### C. Registering a custom tool

```diff
- import { ToolRegistry } from '../../src/main/core/tools.js';
+ import { ToolRegistry } from '@zelari/core/harness/tools';
```

## Behaviour changes you should know about

- **Visible reasoning (council)**: every `agent_start`, `agent_end`,
  `message_start`, `message_delta`, `message_end` event now carries
  optional `memberId` + `memberName`. Consumers that strictly type
  their event handlers will need to mark these fields as optional, or
  type the union more loosely.
- **Headless mode**: new top-level CLI flag `--headless` for scripted
  use. If you wrap `zelari-code` and parse its `stderr` for diagnostics,
  be aware that `--headless` no longer mounts Ink and writes
  NDJSON to `stdout` instead.

## Tooling

- The CLI's own `package.json` now lists `@zelari/core` as a workspace
  dep. Running `npm install` at the repo root will symlink it.
- For downstream projects, install with `npm install @zelari/core@^0.5.0`.
- TypeScript: the package ships `dist/index.d.ts` and per-subpath
  declaration files. No `@types/zelari-core` needed.

## Found a path we missed?

If you find a `src/main/core/`, `src/agents/`, `src/shared/`, or
`src/types/` reference in the wild that should be on this table,
open an issue with the label `migration`. We will:
1. Add a row to this table.
2. If the import is from our own codebase (e.g. a tutorial repo), fix it.

## What we will NOT do

- **No `src/legacy-compat/` shim.** The 9 subpath exports are the
  one and only entry point. The reasoning is in
  [ADR-0005](docs/decisions/0005-deprecate-legacy-src-paths.md).
- **No git tag on pre-0.5.0 paths.** `git log --follow` works as
  expected and gives you the history of any moved file.
- **No esbuild alias plugin.** We don't ship tooling that rewrites
  imports at build time.

## Need help?

- File: [github.com/N-THEM-Studio/zelari-code/issues](https://github.com/N-THEM-Studio/zelari-code/issues)
- Email: maintainers@zelari-code.dev
- Read the [v0.5.0 release notes](CHANGELOG.md#unreleased) for the
  full list of what changed in this release.
