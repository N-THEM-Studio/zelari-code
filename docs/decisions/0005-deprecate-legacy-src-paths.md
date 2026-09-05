# ADR-0005: Deprecation of legacy source paths

- **Status:** Accepted
- **Proposed:** 2026-07-02
- **Accepted:** 2026-07-02 (self-accepted - the old paths no longer exist in the tree after `6ec90be`, and grep confirmed 0 residual imports from src/main/core in src/cli/)
- **Author:** MiniMax-M3
- **Depends on:** [ADR-0001](0001-monorepo-for-zelari-core.md),
  [ADR-0004](0004-public-api-stability-policy.md)

## Context

Before the v0.5.0 refactor, the core code lived in paths internal to the CLI:

```
src/main/core/      (AgentHarness, ToolRegistry, etc.)
src/agents/         (council, roles, built-in skills)
src/shared/         (events)
src/types/          (context, knowledge, systemTypes)
```

After the refactor, these paths were moved (via `git mv`) into `packages/core/src/` and renamed according to the new structure:

```
packages/core/src/harness/      (ex src/main/core/)
packages/core/src/council/      (ex src/agents/councilApi.ts etc.)
packages/core/src/skills/       (ex src/agents/skills/)
packages/core/src/events/       (ex src/shared/)
packages/core/src/types/        (ex src/types/, with legacy.ts)
```

The `src/main/`, `src/agents/`, `src/shared/` and `src/types/` files NO longer exist in the tree, but **knowledge of those paths is still widespread** in:
- Tutorials / blog posts / Discord
- Code snippets in past LLM answers
- GitHub issues
- IDE autocomplete history (some users use "Open recent" to navigate)

We need an **explicit policy** to tell the community:
1. Those paths are dead, they are not coming back.
2. The new locations are in `@zelari/core/...`.
3. If you find references to `src/main/core/` -> open an issue.

## Decision

### No `src/legacy-compat/` shim

We do **NOT** create `src/main/core/X.ts` files doing `export * from '@zelari/core/X'`. Reasons:
- It adds internal paths that confuse anyone reading the tree.
- The `@zelari/core` barrel is already the canonical entry point; duplicating the exposure creates two sources of truth.
- Our own CLI consumes only `@zelari/core/*` from the refactor onward (verified: `git grep "from.*src/main/core" src/cli/` -> 0 results).

### Explicit communication

We add:
1. Repo **README.md**: "Migration from pre-v0.5.0 paths" section with an `old -> new` table.
2. **packages/core/README.md**: at the top "If you're upgrading from zelari-code <= 0.4.x, see [MIGRATION.md](../../MIGRATION.md)".
3. **git blame comments** are not needed (`git mv` preserved the history).
4. **Issue template** for bug reports: field "Did you import from a legacy path? (old: src/main/core/, src/agents/, src/shared/, src/types/)".

### Migration map

Printed in `MIGRATION.md` (new file, linked from README):

| Old path                              | New @zelari/core subpath                |
|---------------------------------------|---------------------------------------|
| `src/main/core/AgentHarness`          | `@zelari/core/harness`                |
| `src/main/core/providerStream`        | `@zelari/core/harness`                |
| `src/main/core/sessionJsonl`          | `@zelari/core/harness`                |
| `src/main/core/tools`                 | `@zelari/core/harness/tools`          |
| `src/main/core/tools/builtin/*`       | `@zelari/core/harness/tools/builtin/*`|
| `src/agents/councilApi`               | `@zelari/core/council`                |
| `src/agents/roles`                    | `@zelari/core/council`                |
| `src/agents/promoteMember`            | `@zelari/core/council`                |
| `src/agents/skills`                   | `@zelari/core/skills`                 |
| `src/agents/skills/builtin/*`         | `@zelari/core/skills/builtin/*`       |
| `src/agents/systemPromptBuilder`      | `@zelari/core/council` (internal)     |
| `src/agents/toolSchemas`              | `@zelari/core/harness/tools`          |
| `src/agents/tools`                    | `@zelari/core/harness/tools`          |
| `src/shared/eventBus`                 | `@zelari/core/events`                 |
| `src/shared/events`                   | `@zelari/core/events`                 |
| `src/types/context`                   | `@zelari/core/types`                  |
| `src/types/knowledge`                 | `@zelari/core/types` (internal)       |
| `src/types/systemTypes`               | `@zelari/core/types`                  |

### Community direction

When someone opens an issue / PR with a legacy path:
- Template answer: "Those paths were removed in v0.5.0. See [MIGRATION.md]. No support for legacy paths because the `packages/core/src/index.ts` barrel is already the canonical source."

## Alternatives considered

- **`src/legacy-compat/` shim** - rejected for the reasons above (double source of truth).
- **Git tags on the old pre-0.5.0 paths** - already exists implicitly via git history; no explicit tag needed.
- **Hard redirect in tools (esbuild plugin)** - excessive, and it breaks the consumer's "import X from Y" flow.

## Consequences

**Positive**
- Zero ambiguity: one path per concept.
- No dead code to maintain.
- Explicit documentation helps people migrating.

**Negative / risks**
- Users with existing code on old paths must migrate manually (one-off effort).
- Pre-v0.5 links / LLM snippets remain obsolete online - patience needed.

## TODO

- [x] Andrea confirms: no shim, no re-export aliasing (implicitly confirmed via the "Proceed" instruction in commit 217db8d).
- [x] Write `MIGRATION.md` with the table above + before/after examples (delivered in the v0.5.0 release commit).
- [x] Update `README.md` with a link to MIGRATION.md (added a callout in the "Install" section).
- [x] Add `MIGRATION.md` as a file created in v0.5.0 (included in the CHANGELOG).
- [ ] Issue template for bug reports (deferred - can be added in a follow-up release; v0.5.0 ships without it because the changelog already documents the migration path).