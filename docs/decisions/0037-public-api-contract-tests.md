# ADR-0037 - Public API contract tests for the three documented interfaces

- **Status:** Accepted
- **Proposed:** 2026-09-11
- **Author:** Kraken (t53 / W5.3), on the W5 API-stability wave
- **Depends on:** [ADR-0004](./0004-public-api-stability-policy.md) (stability tiers + semver policy), [ADR-0003](./0003-versioning-monorepo-policy.md) (lockstep versions)
- **Enforced by:** `packages/core/src/publicApi.contract.test.ts` (vitest)

## Context

ADR-0004 declares tiers and a semver policy, but a tier table in a document is a
**promise**: nothing mechanical stops a refactor from renaming or dropping an
export that consumers were told was stable. The `README` tier table
(`packages/core/README.md`, *API stability tiers*) points at the same promise.

The W5.3 slice was specified as "pin `AgentHarness`, `ToolRegistry`, `Ledger`".
Reading the code changed that list in two ways:

1. **`Ledger` does not exist.** There is no class, function or type named
   `Ledger` anywhere under `packages/core/src`. The resource-ledger surface is
   `ResourceLedgerEntry` (interface) and `ResourceLedgerReason` (type) in
   `runtime/resourceBudget.ts`, plus the pure helpers `computeBudget`,
   `usageFromLedger`, `ledgerDeltaFor`. The `README` already described this
   subpath as "`resourcePolicy`/budget ledger types".
2. **The root barrel is not restricted.** ADR-0004 documents a "restricted root
   barrel"; the file on disk is the opposite - `packages/core/src/index.ts` is
   14 `export *` lines exposing ~518 value exports. That is the actual state, and
   *this* ADR does not change it: tightening the root barrel would itself be a
   breaking change, exactly what ADR-0004 forbids outside a major.

Also worth stating plainly: `ToolRegistry` / `getToolRegistry` are **not**
re-exported by the root barrel. Their public home is the
`@zelari/core/harness/tools` subpath (and the `.../registry` deep subpath). A
contract test that asserted them on the root barrel would be red on day one.

## Decision

The **three documented public interfaces** of `@zelari/core` are pinned by one
co-located test, `packages/core/src/publicApi.contract.test.ts`:

| Interface | Public subpath | Pinned surface |
|---|---|---|
| `AgentHarness` | `@zelari/core/harness` (also root) | `class` + `AgentHarness.prototype.run` |
| `ToolRegistry` | `@zelari/core/harness/tools` | `class` + `.register` / `.invoke`, `getToolRegistry()` |
| Resource ledger | `@zelari/core/runtime` (also root) | `ResourceLedgerEntry`, `ResourceLedgerReason`, `computeBudget`, `usageFromLedger` |
| `CORE_VERSION` | `@zelari/core` (root) | value lockstep with the CLI release |

Rules:

- **Removing a pinned name, or a pinned method on `AgentHarness`/`ToolRegistry`,
  is a BREAKING change → major bump.** That is now a red test, not a review note.
- **Adding exports is additive → minor bump** (ADR-0004). The test therefore
  asserts an **allow-list**, never a snapshot of the whole barrel: a
  ~518-name snapshot would go red on every additive release, i.e. a false-red
  that trains people to update the snapshot blindly.
- **Type-only surfaces are pinned at the type level.** `interface` / `type`
  declarations are erased at runtime, so `expect(typeof api.ResourceLedgerEntry)`
  can only ever fail. The test uses
  `ResourceLedgerEntry['reason'] extends ResourceLedgerReason` for the type pin
  and gives the ledger *shape* runtime teeth by feeding a typed ledger through
  `usageFromLedger` / `computeBudget`.
- **The ledger is `ResourceLedger*`, not `Ledger`.** No `Ledger` class will be
  invented for symmetry; documentation and tests standardize on
  `ResourceLedgerEntry` + `ResourceLedgerReason` + `computeBudget` /
  `usageFromLedger`.
- **No barrel tightening here.** The root barrel stays permissive; the test
  records the real root surface it depends on (`AgentHarness`, `computeBudget`,
  `usageFromLedger`, `CORE_VERSION`) and takes `ToolRegistry` from its own
  subpath.

## Consequences

**Positive**

- The tier table gains teeth: a rename or a dropped export fails a unit test in
  the normal `vitest run` suite, with no new tooling and no new dependency.
- The test doubles as executable documentation of the three interfaces and of
  the "`Ledger` is not a class" correction.
- Cost is ~1s of module-graph import (it loads the root barrel) and one
  allow-list to maintain.

**Negative / residual gaps (honest)**

- The test imports the **source** barrels by relative path, so it does **not**
  catch a regression in `packages/core/package.json` `exports` map or in the
  built `dist/` artifacts. Publishing-level drift is still only covered by
  `npm run build` + `verify-versions`.
- It pins names and class methods, not signatures: renaming a parameter, or
  changing `run()`'s options type incompatibly, stays green. Full signature
  pinning is the api-extractor TODO in ADR-0004, deliberately out of scope here.
- `AgentHarness` and the ledger helpers are pinned on both the root barrel and
  their subpath, so a future intentional root-barrel restriction would require
  editing this test - that edit is the intended tripwire.

## Alternatives considered

1. **Snapshot every root-barrel export** - rejected: the barrel is permissive and
   changes on most minor releases; the snapshot would be noisy, and noise is how
   a contract test dies.
2. **api-extractor / `api-report.md`** - still the right long-term answer
   (ADR-0004 TODO), rejected for this slice: new tooling, new dependency, and a
   generated artifact to keep fresh for zero added runtime value today.
3. **Type-level-only `expectTypeOf` pins** - rejected: vitest does not typecheck,
   and the test files are excluded from `tsc -p packages/core/tsconfig.json`, so
   a type-only pin would never fail in CI.
4. **Document the correction and write no test** - rejected: that is exactly the
   "promise instead of mechanism" failure mode this wave exists to fix.

## TODO

- [ ] Fold the pinned list into the api-extractor `api-report.md` when ADR-0004's
      tooling TODO lands, and delete the duplicated allow-list.
- [ ] Add a published-artifact variant of this test (importing
      `@zelari/core/...` from `dist/`) so an `exports`-map regression is caught
      before publish.
