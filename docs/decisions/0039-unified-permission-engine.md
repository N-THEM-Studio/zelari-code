# ADR-0039 - Unified permission engine: `policyEngine` as the single gate

> **Renumbering note (2026-09-21):** the promoting PREP-ADR proposed
> `docs/decisions/0037-unified-permission-engine.md`; numbers **0037**
> (`public-api-contract-tests`) and **0038** (`node20-floor-and-npx-first-install`)
> were already assigned, so this ADR takes the next free canonical number, **0039**.
> Precedent: ADR-0035 was renumbered from a duplicate `0015` (triage 2026-09-04).
> Content follows the promoted PREP-ADR; the decision is unchanged.

- **Status:** Accepted (phased implementation - adapter-first; engine code NOT yet unified; **Phase 1 landed in t147** - one emission point + parity matrix)
- **Proposed:** 2026-09-21
- **Author:** Zelari Code (BUILD phase, on promotion of the design-vault PREP-ADR, t146)
- **Depends on:** [ADR-0016](./0016-event-sourced-session-log.md) (event-sourced session log), [ADR-0021](./0021-session-spine-contract.md) (spine contract), [ADR-0023](./0023-deterministic-verification-completion.md) (deterministic verification); `src/cli/safety/permissionGate.ts`, `src/cli/safety/policyEngine.ts`, `src/cli/toolRegistry.ts` (restrict-only composition)
- **Prerequisite (met):** the denial ledger is derive-only from the spine (landed and verified before this promotion); Phase 1 step 0 re-checks that `permissionGate.ts` owns no ledger of its own.

## Context

The CLI ships **two** permission engines, and both evaluate `allow | ask | deny`
on the same dispatch:

| | Engine A (WS1 / t133) | Engine B (v2.12) |
|---|---|---|
| Entry point | `src/cli/safety/permissionGate.ts` | `src/cli/safety/policyEngine.ts` |
| Support modules | `permissionPolicy.ts`, `permissionRules.ts` | `policyLayers.ts`, `policyLoadMode.ts`, `resourceClaims.ts` |
| User config | `.zelari/permissions.json` | `.zelari/policy.json` |
| Path syntax | `pathPrefix` | glob `match` |
| Malformed user config | degrades to `ask`, the run continues | strict (headless/CI default) - exit 2 (`POLICY_LOAD_EXIT_CODE`) |
| Spine events | `permission.denied` (through `decisionEmit.ts`) | **none** (only a `[policy] rule '...'` reason string) |
| User surface | `/permissions add`, session rules | per-agent scoping, global floor |

The composition is **restrict-only**: `toolRegistry.ts` intersects every layer
(`intersectEffects`, ~line 1371), so nothing forbidden passes today. The risk is
therefore not a permissive hole, it is divergence:

1. **Semantic divergence** - the same intent written in two syntaxes, in two
   files, can produce different verdicts, and neither engine knows of the other.
2. **UX divergence** - two config files and two path syntaxes, with only one of
   them documented per surface.
3. **Fail-mode divergence** - A degrades a malformed user config to `ask`; B kills
   a headless/CI run with exit 2. Same class of mistake, two different runs.
4. **Partial observability** - only A emits `permission.denied` on the spine, so a
   denial decided by B is invisible to replay, to the inbox and to the ledger.

## Decision

**`policyEngine` (B) becomes the single permission engine; `permissionGate`
degrades to a backwards-compatibility adapter.**

1. **Compat layer.** `.zelari/permissions.json` keeps being read and is translated
   (`pathPrefix` -> glob) into native B rules, with a deprecation warning. The
   window is **two minor releases**; the file is honored, never silently ignored.
2. **One emission point.** `permission.denied` is emitted only at the final
   decision point - never by the compat layer, never twice per dispatch.
3. **Unified fail-mode.** A malformed *user* config degrades to `ask` + warning;
   exit 2 stays reserved for an *explicit* strict policy load (headless/CI) and is
   documented as such.
4. **One documented syntax.** `docs/GUIDA.md` and `docs/TOOLS.md` document the B
   syntax only; `MIGRATION.md` documents the translation and the window.
5. **Restrict-only composition is preserved.** The intersect at the dispatch
   choke-point is not weakened while the engines are merged.

### Phases

- **Phase 1 - spine events from one point + parity matrix.** Move the
  `permission.denied` emission to the single final decision point; add a test
  matrix asserting command -> verdict identity between translated A syntax and
  native B syntax.
- **Phase 2 - compat adapter + deprecation warning.** Ship the
  `.zelari/permissions.json` translation with the two-minor window, warning on load.
- **Phase 3 - remove engine A.** At the end of the window, delete the A entry
  point and its config surface; `MIGRATION.md` records the removal.
- Effort estimate: **800-1200 LOC + tests**; `toolRegistry.ts` is the hot dispatch
  path, so the work lands in separate slices with verification after each slice.

## Consequences

**Positive**

- One decision path, one config syntax, one fail-mode, one observation point: a
  denial decided anywhere becomes replayable, inbox-visible and ledger-visible.
- Existing WS1 users keep working through the adapter instead of meeting a
  breaking change.

**Negative**

- A compatibility layer survives for two minors: translation code plus a
  deprecation window to police (accepted - cheaper than breaking live configs).
- Merging the engines touches the `toolRegistry.ts` dispatch, and the deny path is
  high-impact: the parity matrix is a release blocker, not a nice-to-have.

**Neutral**

- The adapter is transitional by design: Phase 3 deletes it, and this ADR is the
  record of why it existed.

## Alternatives considered

1. **B absorbs A without a compat layer** - rejected: breaks existing WS1 users on
   `.zelari/permissions.json` with no migration path.
2. **A absorbs B** - rejected: loses per-agent scoping and the global floor; B is
   more expressive and more recent.
3. **Document both engines and keep both running** - rejected: fixes neither
   observability nor divergence, and turns the divergence permanent by writing it
   down as intended.

## Acceptance gate (implementation)

- [x] A unique grep target for the `permission.denied` emission point in the tree
      (t147: `emitPermissionDenied` is called from ONE place, the final deny
      branch of `wrapWithPermissions` in `toolRegistry.ts`).
- [x] Parity test matrix: command -> verdict identical between translated A syntax
      and native B syntax (`src/cli/safety/permissionParity.test.ts`; the
      translation seed is `permissionAdapter.translatePermissionRule`).
- [ ] `.zelari/permissions.json` deprecated but still honored via the adapter
      (translation tests). NOT yet: Phase 1 ships the pure translation + its
      tests, the load path that honors the file through B is Phase 2.
- [x] `npm run typecheck` exit 0 and the `src/cli/safety` suite green.
- [ ] `MIGRATION.md` updated at the end of the work.

## TODO

- [x] Phase 1 step 0: confirm the spine is the only denial ledger (no second
      ledger in `permissionGate.ts`). Re-verified: no in-process denial buffer
      (`MAX_RECENT_DENIALS` / `listRecentPermissionDenials` /
      `recordPermissionDenial` / `clearPermissionDenials` absent from product
      code in `src/` and `packages/`).
- [x] Phase 1: single emission point + parity matrix. Every deny (engine A
      verdict, engine B rule/claim, TaskContract, category default) is recorded
      exactly once, at the final decision point; the payload names the deciding
      layer and is contract-checked before the sink is touched.
- [ ] Phase 2: compat adapter + deprecation warning (two-minor window).
- [ ] Phase 3: remove engine A; update `docs/GUIDA.md`, `docs/TOOLS.md`,
      `MIGRATION.md`.
