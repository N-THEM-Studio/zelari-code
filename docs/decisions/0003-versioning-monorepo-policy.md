# ADR-0003: Versioning schema for the zelari-code monorepo

- **Status:** Accepted
- **Proposed:** 2026-07-02
- **Accepted:** 2026-07-02 (self-accepted - version 0.5.0-dev.0 already in packages/core/package.json implicitly couples the versions)
- **Author:** MiniMax-M3
- **Depends on:** [ADR-0001](0001-monorepo-for-zelari-core.md),
  [ADR-0002](0002-publish-zelari-core-to-npm.md)

## Context

With the monorepo we have two distinct packages:

| Package           | Path            | Consumers                          |
|-------------------|-----------------|------------------------------------|
| `zelari-code`     | root            | End users (CLI)                    |
| `@zelari/core`    | packages/core   | `zelari-code` + (future) third parties |

We need a policy: when one bumps, does the other follow? Independent
versioning (= two release cycles, two CHANGELOGs) or coupled (a single
git tag, same version)?

## Decision

**Coupled versioning in the v0.5.x phase, independent from v0.6+.**

- v0.5.0 -> CLI and core both published as `0.5.0`, same git tag
  `v0.5.0`.
- v0.5.1 -> both as `0.5.1`, same tag `v0.5.1`.
- From v0.6.0 on: the core publishes when it has breaking changes or
  significant fixes, the CLI only when needed. Distinct tags:
  - `v0.6.0/core` -> only `@zelari/core@0.6.0`
  - `v0.6.0/cli` -> only `zelari-code@0.6.0`
  - `v0.6.0` -> both (joint release)

### Semantic versioning schema

- `MAJOR` (X.0.0) -> breaking change in the core's public API or a
  radical CLI UX change.
- `MINOR` (0.X.0) -> new feature, backward-compatible.
- `PATCH` (0.0.X) -> bug fix, backward-compatible.

Pre-1.0 (we are at `0.X.Y`): every MINOR may contain breaking
changes documented in the CHANGELOG. From 1.0 on: strict semver,
MAJOR reserved for breaking changes.

### Pragmatism during the `0.5.x` period

Why coupled at the start:
- Single team, single release window, no overhead.
- A single tag is trivial: `git tag v0.5.0 && git push --tags -> CI
  does everything`.
- Switching to independent in v0.6 is a local operation (tag scheme
  + workflow branching), it costs nothing.

## Alternatives considered

- **Independent from day one** - doubles release overhead (two PRs,
  two changelogs, two publishes) for flexibility we do not use yet.
- **Monolithic forever (CLI = core version)** - works until the core
  has a life of its own; after the extraction into @zelari/core it
  would be incoherent.
- **CalVer (YY.MM.PATCH)** - attractive but breaks the team's semantic
  mindset; in open-source npm literature semver dominates.
- **Changesets-style (one changeset per release)** - interesting when
  scaling to 5+ packages; overkill for 2 packages.

## Consequences

**Positive**
- Simple, predictable v0.5.x shipping.
- Clear migration path: from 0.6 each goes its own way.
- A single CHANGELOG (`/CHANGELOG.md`) for now, with per-package
  sections. Split in two when needed.

**Negative / risks**
- Coupled versioning is an anti-pattern for npm in the long run
  (core consumers do not want to re-download CLI patches).
- We must remember to split at 0.6, otherwise it becomes cultural
  debt.

## TODO

- [ ] Andrea confirms: start coupled, split at 0.6?
- [ ] CI matrix setup in `.github/workflows/release.yml`:
      automatic detection of which package changed in the diff
      between tags.
- [ ] `CHANGELOG.md` with `## @zelari/core` and `## zelari-code`
      sections.