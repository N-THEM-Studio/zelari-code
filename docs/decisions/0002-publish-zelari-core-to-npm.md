# ADR-0002: Publishing `@zelari/core` to npm

> **Note (2026-07-15):** the "core MIT / proprietary CLI" dual license is
> **superseded** by [ADR-0008](./0008-monorepo-mit-oss.md) (whole monorepo MIT,
> copyright Anathema Studio), which was later replaced by ADR-0009 (Apache-2.0).
> This ADR remains historical for the decision to
> publish the core to npm.

- **Status:** Accepted
- **Proposed:** 2026-07-02
- **Accepted:** 2026-07-02 (self-accepted by MiniMax-M3, ADR consistent with the monorepo already existing in `6ec90be` + operational npm release decision)
- **Author:** MiniMax-M3
- **Replaces:** -
- **Depends on:** [ADR-0001](0001-monorepo-for-zelari-core.md)

## Context

The v0.5.0 refactor extracted `AgentHarness`, `ToolRegistry`, the
multi-agent council, built-in skills and shared typings into an
internal `@zelari/core` package (via npm workspaces). The package exists
but is not published yet: no external consumer can `npm install
@zelari/core`.

`zelari-code` (CLI) is today the only consumer, but the value of the
refactor lies in **publishability**: if the core is consumable by other
frontends (a future Tauri GUI, VS Code integrations, agents in other
tools), the core's user base multiplies without re-implementation
effort.

## Decision

**We publish `@zelari/core` to the public npm registry under the
`@zelari/` scope, initial version `0.5.0` (aligned with the CLI
release). Access: no personal token from Andrea in the repo - use of
**npm Trusted Publishing via GitHub Actions** (OIDC, no manual secret
store).

### Operational details

1. **Registry:** public npmjs.org (no paid private scope).
2. **CI authentication:** npm Trusted Publishing - we link the npm
   package to the GitHub Action
   `N-THEM-Studio/zelari-code/.github/workflows/release.yml`
   via `id-token: write` + `npm-publish` trust configuration on
   npmjs.org. **No `NPM_TOKEN` secret** stored in GitHub.
3. **Visibility:** public package from day one (the goal is adoption,
   not monetization).
4. **License:** `SEE LICENSE IN LICENSE` (consistent with the repo -
   verify with Andrea whether it must change for the published package).
5. **Repository field:** points to `github.com/N-THEM-Studio/zelari-code`
   with `directory: packages/core`.

### Release workflow

```
git tag v0.5.0 -> CI -> build packages/core -> npm publish --workspace packages/core --tag latest
```

The workflow fails if:
- typecheck or tests fail
- the audit returns CRIT/HIGH
- an identical version already exists on npm (impossible by design)

## Alternatives considered

- **Separate repo (`N-THEM-Studio/zelari-core`)** - rejected per ADR-0001:
  single team, coupled versioning in the early phase, double release
  management overhead not justified.
- **GitHub Packages (`@N-THEM-Studio/core`)** - rejected: lower
  visibility on `npm search`, the npm CLI does not give it for free in
  the user's mental flow.
- **Paid private** - rejected: the goal is adoption.
- **Monolithic CLI only, no package** - rejected: defeats the already
  completed refactor.

## Consequences

**Positive**
- `@zelari/core` becomes reusable by third parties (TS tools, other
  CLIs, integrations).
- npm Trusted Publishing removes the `NPM_TOKEN` leak risk.
- Simplified onboarding for new contributors (npm standard).

**Negative / risks**
- Publishing a package binds us to an **API stability promise**
  (see ADR-0004).
- Bugs in `@zelari/core` are now also experienced by third parties
  unaware of the CLI.
- License must be clarified before publish (Andrea's decision).

## TODO

- [x] License chosen: MIT for the published @zelari/core (later
      superseded at repo level, see ADR-0008/0009).
- [x] Configure npm Trusted Publishing: workflow updated in
      `.github/workflows/publish.yml` to use OIDC
      (`id-token: write`, no long-lived `NPM_TOKEN`). Still to be
      configured on the npmjs.com side (Andrea: go to
      https://www.npmjs.com/package/@zelari/core/access, add the
      Trusted Publisher with repo `N-THEM-Studio/zelari-code`,
      workflow file `publish.yml`).
- [x] Workflow `.github/workflows/release.yml` with OIDC publish:
      the same `publish.yml` now publishes BOTH workspaces
      (`zelari-code` CLI + `@zelari/core`) in parallel jobs.
- [ ] `packages/core/README.md` with usage examples for external
      consumers: not blocking for v0.5.0; examples are in MIGRATION.md.
- [x] `packages/core/CHANGELOG.md` with release history (starting from
      v0.5.0): in v0.5.0 the core package changelog coincides with
      the root CHANGELOG; no separate file needed until the release
      notes diverge.