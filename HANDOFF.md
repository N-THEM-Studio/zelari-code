> **SUPERSEDED** - historical snapshot; current state lives in README.md, CHANGELOG.md and docs/decisions/. Not onboarding docs.

# Zelari Code - Handoff Option B (2026-07-03)

> **?? Historical / superseded (v0.7.8 Option B) - not required for contributors.**  
> Current product: **zelari-code 1.34.0**. Use [CONTRIBUTING.md](./CONTRIBUTING.md),  
> [CHANGELOG.md](./CHANGELOG.md), and [docs/GUIDA.md](./docs/GUIDA.md).  
> Product identity: [Anathema Studio](https://anathema-studio.com/).

> **?? SUPERSEDED (2026-07-03, follow-up session on Windows)**
>
> The gaps described below (section 4 - 4 generic tasks instead of 12,
> section 5.1 - duplicated `risks-md.md`, section 5.3 - unversioned
> script) were **resolved at codebase level** in v0.7.8. See
> `docs/plans/2026-07-03-council-createplan-batch-builtin-fallback.md`.
>
> In summary:
> 1. New batch tool **`createPlan`** - Nettuno persists the whole plan
>    (phases + nested tasks + milestones) in ONE tool call, instead of
>    the 17 sequential ones composer-2.5 could not sustain.
> 2. **Retry re-enabled for Nettuno** (`NON_RETRY_AGENTS` empty): with a
>    budget of 1 call it is the same shape that already worked for
>    Minosse/Lucifero. OR-of-sets requirements: `createPlan=1` OR the
>    itemized trio (strong models are not flagged).
> 3. **Built-in complete-design fallback in TypeScript**
>    (`src/cli/workspace/completeDesign.ts`): >=3 tasks per phase derived
>    from the REAL phases of plan.json (the phase-ID mismatch is
>    impossible by construction) + guaranteed milestone. The workspace
>    script `complete-design.mjs`, when present, still takes precedence.
> 4. Schema<->stub fixes (`fileRefs`/`acceptance`/`qaScenario` on
>    createTask, `targetVersion` on createMilestone, aliases for
>    linkDocuments and getDocumentBacklinks) and `.md` title
>    normalization in createDocument (no more `docs/risks-md.md`).
>
> Tests: **919/919 GREEN** on Windows (from 907; also fixed a
> pre-existing win32 bug in the hook test). Remaining: live validation
> with `COUNCIL_MODEL=composer-2.5` on a real workspace (the
> `borsa-lusso-react` workspace does not exist on this machine).

## TL;DR

Option B is **mechanically complete and pushed** to the `zelari-code`
`main` branch (commit `3aaa45d`, on top of `57a71cb`). The end-to-end
flow works: Nettuno no longer wastes retries, chairman + oracle keep the
retry that works, and `complete-design.mjs` is auto-invoked at the end of
the council.

**BUT there is a known gap**: you get **4 generic tasks** instead of the
**12 domain-curated tasks** the `complete-design.mjs` template provides.
The cause is a mismatch between the phase IDs the council generates and
the ones the template maps.

When you resume the work, start from **section 4 (known gap and proposed
fixes)** - all the context to close the loop is there.

---

## 1. `zelari-code` repository state

- **Branch**: `main`
- **Last pushed commit**: `3aaa45d` - "v0.7.7 Option B: skip
  retry for Nettuno + auto-invoke complete-design"
- **Diff vs `57a71cb` (Pass 3)**:
  - `packages/core/src/agents/councilApi.ts` (+18/-2)
    - New export `NON_RETRY_AGENTS: ReadonlySet<string> = new Set(['nettun'])`
    - Specialist loop: `if (!errored && !NON_RETRY_AGENTS.has(agent.id))`
  - `src/cli/workspace/postCouncilHook.ts` (+147/-19)
    - New function `runCompleteDesignPostProcessor(ctx)`:
      spawns `complete-design.mjs` as a child process,
      gated by `.zelari/plan.json` with >=1 phase,
      opt-out via `ZELARI_COMPLETE_DESIGN=0`
    - `runPostCouncilHook` now orchestrates two steps in sequence:
      AGENTS.MD first, complete-design after
    - New type `PostCouncilHookResult` with a `completeDesign` field
  - `tests/unit/cli-workspace-complete-design-hook.test.ts` (NEW,
    +213 LOC) - 7 tests
  - `tests/unit/cli-councilToolEmission.test.ts` (+29 LOC) - 3 tests
    on `NON_RETRY_AGENTS`

## 2. Tests

- **907/907 GREEN** (before: 897, +10 new)
- 7 new in `cli-workspace-complete-design-hook.test.ts`:
  - no plan.json -> no run
  - plan.json without phases -> no run
  - no complete-design.mjs -> no run
  - plan + script OK -> exit 0
  - script fails -> exit code without throwing
  - `ZELARI_COMPLETE_DESIGN=0` -> skip
  - `runPostCouncilHook` invocation order (AGENTS.MD first,
    complete-design after)
- 3 new in `cli-councilToolEmission.test.ts`:
  - `NON_RETRY_AGENTS.has('nettun') === true`
  - `NON_RETRY_AGENTS.has('gerion'/'pluton'/'caronte') === false`
  - `NON_RETRY_AGENTS.has('lucifer'/'minos') === false`

## 3. Live validation (composer-2.5)

Full wipe of `.zelari/`, `AGENTS.MD`, then `COUNCIL_MODEL=composer-2.5
npx tsx run-council.mjs`. Result:

```
[15:37:10.836] agent_start  member=Nettuno  model=composer-2.5
[council] member "nettun" did not emit required tools: createTask (got 0,
  need >= 6), createMilestone (got 0, need >= 1). (...) (Pass 3 may add
  automatic retry; see plan 2026-07-03-council-design-phase-role-anchoring.md.)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  NO "retrying missing tools" line after this warning
                  (confirmed: NON_RETRY_AGENTS skipped the retry)

[15:38:54.870] agent_start  member=Minosse  model=composer-2.5
[council] member "minos" did not emit required tools: createDocument (got 0, need >= 1).
[council] minos retrying missing tools: createDocument
[15:39:08.117] agent_start  member=Minosse  model=composer-2.5  <-- retry triggered
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  confirmed: oracle retry works, creates risks.md

[15:39:30.198] agent_start  member=Lucifero  model=composer-2.5
[council] member "lucifer" did not emit required tools: createDocument (got 0, need >= 1).
[council] lucifer retrying missing tools: createDocument
[15:39:35.524] agent_start  member=Lucifero  model=composer-2.5  <-- retry triggered
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  confirmed: chairman retry works, creates synthesis.md

[post-hook] complete-design ran (exit=0)
[post-hook] AGENTS.MD updated: tech-stack, decisions, conventions, build, open-questions
```

**Final bundle**:

```
.zelari/
  |- plan.json                    # 4 phases, 4 tasks, 1 milestone
  |- plan.md                      # regenerated by the post-processor
  |- risks.md                     # Oracle retry (2863 bytes)
  |- decisions/
  |   |- 000-adr-000-bootstrap...md
  |   |- 001-adr-001-react-19-vite-6-and-typescript-strict-mode.md
  |   |- 002-adr-002-stripe-as-sole-payment-and-checkout-orchestration.md
  |   |- 003-adr-003-mdx-for-editorial-and-campaign-content.md
  |   |- 004-adr-004-wcag-2-2-level-aa-as-non-negotiable-ux-baseline.md
  |   |- 005-adr-005-bilingual-i18n-italian-default-and-english.md
  |   |- 006-adr-006-headless-catalog-api-boundary-and-bff-lite-pattern.md
  |- docs/
  |   |- information-architecture.md       # Gerione
  |   |- luxury-design-tokens.md            # Gerione
  |   |- customer-journey-map.md            # Gerione
  |   |- risks-md.md                        # (?) see section 5
  |   |- synthesis-md.md                    # Lucifero retry (6110 bytes,
  |                                          # title "synthesis-md" gets
  |                                          # .md appended automatically by the tool)
  |- milestones/
  |   |- m-mvp-luxury-storefront-design-complete.md
  |- plan-tasks/
      |- foundation-technical-blueprint-t1-...md
      |- ux-ia-design-system-t1-...md
      |- commerce-content-t1-...md
      |- quality-sign-off-t1-...md
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      ONLY 4 TASKS (known gap - see section 4)

AGENTS.MD                       # auto-generated, 5 sections
```

## 4. Known gap and proposed fixes

### 4.1 - 4 generic tasks instead of 12 curated ones

**Symptom**: the post-processor generates 1 task per phase (generic
fallback) instead of the 3 curated tasks the template provides.

**Cause**: mismatch between the council's phase IDs and the template's
`TASKS_PER_PHASE` phase IDs in `complete-design.mjs`.

| Council produces | Template looks for | Result |
|---|---|---|
| `foundation-technical-blueprint` | `phase-1-discovery-product-definition` | generic fallback |
| `ux-ia-design-system` | `phase-2-information-architecture-ux` | generic fallback |
| `commerce-content` | `phase-3-luxury-design-system` | generic fallback |
| `quality-sign-off` | `phase-4-technical-blueprint-readiness` | generic fallback |

The fallback is:
```js
{
  title: `${phase.name} - implementation tasks`,
  description: phase.description || `Concrete implementation work for phase "${phase.name}".`,
  acceptance: [
    'Phase exit criterion defined in the synthesis doc is satisfied',
    'All artifacts referenced by this phase exist and are current',
  ],
  qa: 'Walk the synthesis green-light checklist and confirm this phase has a passing row.',
}
```

### 4.2 - Proposed fixes (pick one)

#### Option A - Update the mapping in the template

**File**: `~/zelari-projects/borsa-lusso-react/complete-design.mjs`

**Change**: replace the `TASKS_PER_PHASE` keys with the council's real
phase IDs. Example:

```js
const TASKS_PER_PHASE = {
  'foundation-technical-blueprint': [
    { title: 'Lock React 19 + Vite 6 + TS strict baseline', ... },
    { title: 'Define NFR budget (LCP, WCAG, Lighthouse)', ... },
    { title: 'Document design-phase exit criteria', ... },
  ],
  'ux-ia-design-system': [
    { title: 'Finalize sitemap & route map', ... },
    { title: 'Wireframe key pages (PLP, PDP, cart, checkout)', ... },
    { title: 'Specify faceted search contract', ... },
  ],
  // ... etc.
};
```

**Pro**: domain-specific tasks, reusable for future runs without
touching the codebase.

**Con**: duplicates the domain knowledge the council should have. If
the council changes phase IDs, the template needs updating again.

**LOC**: ~150 in the workspace file, 0 in the codebase.

**Estimate**: 10 minutes.

#### Option B - Fuzzy match by prefix

**Change**: make the match prefix-based instead of equality-based.

```js
const TASKS_PER_PHASE = {
  'foundation': [ /* 3 curated generic tasks for any phase
                    starting with 'foundation' */ ],
  'ux-ia': [ /* 3 tasks */ ],
  'commerce': [ /* 3 tasks */ ],
  'quality': [ /* 3 tasks */ ],
};

// Match
let phaseTasks = TASKS_PER_PHASE[phase.id];
if (!phaseTasks) {
  // Fallback: search by prefix (e.g. 'foundation-technical-blueprint' -> 'foundation')
  const prefix = Object.keys(TASKS_PER_PHASE).find((k) => phase.id.startsWith(k));
  phaseTasks = prefix ? TASKS_PER_PHASE[prefix] : undefined;
}
```

**Pro**: more robust to future phase renames.

**Con**: less specific (the 3 generic tasks for `foundation` get reused
for any phase starting with `foundation`).

**LOC**: ~30 (refactor of the existing mapping + match logic).

**Estimate**: 5 minutes.

#### Option C - Keep the generic fallback

One day the model (Opus) will produce the tasks via real `createTask`
calls and the post-processor will just be a safety net. For now, 4
generic tasks are enough to proceed with implementation.

**Pro**: no work.

**Con**: the generic tasks have no domain-specific descriptions, they
are "phase exit criterion satisfied" - which is fuzzy.

### 4.3 - Recommendation

**Option B** (fuzzy match) - it is the middle ground. 5 minutes of work,
zero regression risk, and it produces more sensible tasks than the
current 4 generic ones.

## 5. Other artifacts to check

### 5.1 - Duplicated `risks-md.md`

The run contains **both** `risks.md` (root of `.zelari/`, created by the
Oracle retry) **and** `docs/risks-md.md` (probably created by the
chairman retry or a previous run). Check whether it is a chairman bug
(is it trying to create `risks.md` instead of `synthesis.md`?) or just a
leftover stub.

**File to inspect**: `~/zelari-projects/borsa-lusso-react/.zelari/docs/risks-md.md`

If it is empty/stub, delete it.

### 5.2 - Pass 3 allowlist files

For the record: the Pass 3 prompt mentioned `councilApi.ts`,
`cli-councilToolEmission.test.ts`, `council-chairman.test.ts`. In
Option B I added `postCouncilHook.ts` + a new test file. Everything
pushed without violations.

### 5.3 - Workspace driver

`~/zelari-projects/borsa-lusso-react/run-council.mjs` was modified
locally to invoke `runPostCouncilHook` after the council (lines
295-324). It is **NOT versioned** (the workspace is not a git repo). To
version it, initialize a repo there or move `run-council.mjs` to
`zelari-code/packages/cli/scripts/`.

## 6. Useful commands to resume

```bash
# Check repo state
cd ~/zelari-code
git log --oneline -5
git status

# Run the test suite (must be 907/907 GREEN)
cd ~/zelari-code && npx vitest run

# Live council run (wipe + rebuild)
cd ~/zelari-projects/borsa-lusso-react
rm -rf .zelari/ AGENTS.MD
COUNCIL_MODEL=composer-2.5 npx tsx run-council.mjs

# Check the final bundle
ls .zelari/plan-tasks/ | wc -l   # must be 12 if the Option B fix is applied
ls .zelari/                      # phases, tasks, milestones, risks.md, synthesis.md
cat .zelari/plan.json | python3 -c "import sys, json; p=json.load(sys.stdin); print(f'phases={len(p[\"phases\"])}, tasks={len(p[\"tasks\"])}, milestones={len(p[\"milestones\"])}')"
```

## 7. Claude CLI auth

**Token expired**: 2026-06-29 11:05:36 (~4 days before Option B).

To restore Opus for the council (the model that produces real tasks via
`createTask` instead of requiring the post-processor), you must
manually complete the `claude auth login` browser flow.

While you use `composer-2.5`, Option B is the deterministic workaround.

## 8. Recommended next steps

In priority order:

1. **4.3 - Apply Option B (fuzzy match) to close the 4-vs-12-task gap.**
   5 minutes of work, high value.
2. **5.1 - Investigate the duplicated `risks-md.md`.** 5 minutes.
3. **5.3 - Version `run-council.mjs` or move it to
   `packages/cli/scripts/`.** If you want future workspaces to inherit
   the same integration.
4. **7 - Restore Claude CLI auth to unlock Opus.** Unlocks the model
   that does the tasks by itself, removing the need for the
   post-processor for Nettuno.
5. **Refactor `councilApi.ts` (1138 LOC) into separate modules
   (orchestrator / specialists / oracle / chairman / post-condition).**
   Half a day of work, high technical debt if the codebase grows.
6. **Dependabot dependencies** (1 critical, 1 high, 3 moderate) - update
   before release.

---

**Files attached to this handoff**:

1. `HANDOFF.md` (this file)
2. `complete-design.mjs` - current copy of the post-processor (392 LOC)
3. `run-council.mjs` - modified driver with post-hook auto-invoke
4. `.zelari/` snapshot - full bundle generated by the last live run

Good resuming!