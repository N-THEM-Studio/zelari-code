# ADR-0004: Public API stability policy for `@zelari/core`

- **Status:** Accepted
- **Proposed:** 2026-07-02
- **Accepted:** 2026-07-02 (self-accepted - the 9 subpaths are already written and working in the packages/core/package.json exports map)
- **Author:** MiniMax-M3
- **Depends on:** [ADR-0002](0002-publish-zelari-core-to-npm.md),
  [ADR-0003](0003-versioning-monorepo-policy.md)

## Context

As soon as we publish `@zelari/core`, any rename, signature
change, or removed type becomes a breaking change for external
consumers we do not control (potentially).

We must decide:
1. Which subset of `@zelari/core/*` is **stable public API**?
2. How do we handle breaking changes during `0.X.Y` (pre-1.0)?
3. What is the deprecation process?

## Decision

### Stable public API in v0.5.0

We explicitly export as stable ONLY the defined barrels, and **not**
the internal subpaths:

| Subpath                    | Status v0.5.0 | Notes                                  |
|----------------------------|--------------|---------------------------------------|
| `@zelari/core`             | **stable**   | Root barrel (restricted subset, see below) |
| `@zelari/core/harness`     | **stable**   | `AgentHarness`, provider-neutral loop |
| `@zelari/core/council`     | **stable**   | Council API, roles, promoteMember     |
| `@zelari/core/skills`      | **stable**   | Registry of built-in skills           |
| `@zelari/core/events`      | **stable**   | `BrainEvent`, `EventBus`              |
| `@zelari/core/types`       | **stable**   | Public types only (no `legacy.ts`)    |
| `@zelari/core/harness/tools` | **stable** | `ToolRegistry`, tool types           |
| `@zelari/core/harness/tools/builtin/*` | **stable** | The 6 built-in tools       |
| `@zelari/core/skills/builtin/*` | **stable** | The 7 built-in skills            |

### Restricted root barrel

The file `packages/core/src/index.ts` exposes ONLY:
- `AgentHarness`, `ProviderStream` (from harness)
- `Tool`, `ToolContext`, `ToolResult` (from tools)
- `EventBus`, `BrainEvent` (from events)
- `createCouncil`, `CouncilMember`, `MemberRole` (from council)
- `registerBuiltInSkills` (from skills)
- Types from `types/context` and `types/systemTypes`

It does **NOT** expose from root:
- AgentHarness internals (private helpers)
- `legacy.ts` (historical types)
- mock/test utilities
- `councilDirectives` (internal configuration)

### Everything else is `@internal`

Any export not listed above is considered **internal** and may
change without notice between minor or patch, even during 0.5.x. We
mark it with a `@internal` JSDoc comment at the top of the file.

### Breaking changes in 0.X.Y

During the pre-1.0 phase (`0.5.x`, `0.6.x`, etc.):

1. **Deprecation cycle:**
   - Deprecate an export via `/** @deprecated use X */` JSDoc.
   - Keep the export working for **at least 2 minor releases**
     (e.g. deprecated in 0.5.0 -> removed no earlier than 0.7.0).
   - `console.warn` log the first time a consumer imports the
     deprecated symbol (in dev mode).

2. **Documented migration:**
   - Every deprecation adds a line in `CHANGELOG.md` under a
     `### Deprecated` section + a link to a migration snippet.
   - Our own CLI (the only initial consumer) is migrated in the
     same release as the deprecation.

3. **MAJOR bump** (1.0) only when:
   - The public API covers >= 90% of real use cases (Andrea's
     subjective decision).
   - An audit confirmed no known external consumer is impacted.
   - Barrel test coverage exceeds 80%.

### JSDoc convention

```typescript
/**
 * Create a new agent loop bound to a provider stream.
 * @public
 * @since 0.5.0
 */
export function createHarness(...): AgentHarness { ... }

/**
 * @deprecated since 0.7.0 - use `createHarness` instead.
 *             Will be removed in 1.0.0.
 */
export function legacyHarness(...): AgentHarness { ... }

// internals - no JSDoc, name starting with underscore OK
function _internalHelper() {}
```

## Alternatives considered

- **No policy, "pure" semver like any npm package** - works,
  but does not help consumers know what is stable; the barrel is
  the only anchor, and deep subpaths remain a "gray zone".
- **Everything is stable (no `@internal`)** - impossible to maintain,
  every refactor becomes breaking.
- **Total API freeze in 0.5 (zero changes until 1.0)** - blocks
  innovation; the refactor is not finished yet.

## Consequences

**Positive**
- An explicit barrel gives the consumer a clear entry point.
- The 2-release deprecation cycle gives consumers time to migrate.
- `console.warn` only in dev mode does not impact production.

**Negative / risks**
- A too-restricted barrel frustrates consumers who must import
  from many subpaths.
- Discipline in marking `@internal` is easy to lose.
- A 2-release deprecation is long during 0.X.Y (we release
  frequently); perhaps too long.
- Tooling is needed to generate `@since` automatically (TS API
  extractor, api-extractor) to avoid drift.

## TODO

- [ ] Andrea reviews the "stable API v0.5.0" list and adds/removes.
- [ ] Add `@public`/`@internal`/`@deprecated` JSDoc on all barrel
      exports.
- [ ] Set up api-extractor to generate `packages/core/api-report.md`
      (single source of truth for "what is public").
- [ ] Discuss whether the deprecation cycle should be shortened to
      1 minor during 0.X.Y (fast releases).