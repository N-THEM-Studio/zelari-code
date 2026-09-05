# ADR-0001: Monorepo with npm workspaces for `@zelari/core`

- **Status:** Accepted
- **Proposed:** 2026-07-01
- **Accepted:** 2026-07-01 (implicit, via commit `6ec90be`)
- **Author:** MiniMax-M3 (proposal) / Andrea (decision)

## Context

Before v0.5.0, `zelari-code` was a monolithic package. The
"logically extractable" code (AgentHarness, ToolRegistry,
council, skills, events) lived in `src/main/core/` and `src/agents/`,
but shared `package.json`, `tsconfig.json`, and dependencies with the
CLI.

The v0.5.0 plan (`docs/plans/2026-07-01-v0-5-0-roadmap.md`) proposed
the extraction as a prerequisite for publishing the core as a
reusable `@zelari/core` package for third parties.

## Decision

**Use a monorepo with npm workspaces**, layout:

```
zelari-code/
+- package.json          # "workspaces": ["packages/*"]
+- tsconfig.json         # root, excludes packages/*
+- packages/
|   +- core/             # @zelari/core
|       +- package.json  # name, version, exports map
|       +- tsconfig.json # composite: true
|       +- src/
|           +- harness/      (AgentHarness, providerStream)
|           +- council/      (councilApi, roles, promoteMember)
|           +- skills/       (registry + built-in)
|           +- events/       (BrainEvent, EventBus)
|           +- types/        (context + systemTypes + legacy.ts)
|           +- index.ts      (root barrel)
+- src/cli/              # zelari-code CLI (consumer of @zelari/core)
+- tests/                # CLI tests
```

### Accepted motivations

1. **Single team, single repo, single release.** Core and CLI
   evolve in sync; forcing separation now adds overhead
   without value.
2. **Native workspace symlink:** npm install creates
   `node_modules/@zelari/core -> ../../packages/core`, zero magic.
3. **`tsc --build` with `composite: true`** enables incremental
   cross-package builds without intermediate bundlers (esbuild
   keeps bundling the final CLI).
4. **Migration to a separate repo remains possible** in the future (it is a
   mechanical refactor: `git subtree split` on `packages/core/` +
   new repo).

### Things NOT decided here

- npm publishing -> ADR-0002
- Versioning schema -> ADR-0003
- Public API stability -> ADR-0004
- Legacy deprecation path -> ADR-0005

## Consequences

**Positive**
- Refactor done in one atomic commit (`6ec90be`), with 100% rename
  detection via git.
- 692/692 tests green after the migration.
- Zero downtime for CLI users: no UX change.
- Opens the road to Phase 2 (wizard) without further renames.

**Negative / risks**
- Heavier `node_modules` (workspaces installs dependencies both
  for root and `packages/core`, even if identical).
- Test count unchanged (692 -> 692), but the plan's "= 800"
  threshold for v0.5.0 was missed -> to recover in Phase 2.

## TODO

- [x] Create `packages/core/` with barrel structure.
- [x] Redirect CLI imports to `@zelari/core/*`.
- [x] Add `workspaces` to root `package.json`.
- [x] Configure `exports` map in `packages/core/package.json`.
- [ ] Publish (depends on ADR-0002).