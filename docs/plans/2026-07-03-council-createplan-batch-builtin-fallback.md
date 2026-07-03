# Council v0.7.8 — createPlan batch tool + built-in complete-design fallback

- **Date**: 2026-07-03
- **Branch**: main
- **Type**: structural fix (tooling + orchestration) — supersedes v0.7.7 Opzione B

## Problem

The v0.7.7 state (HANDOFF.md 2026-07-03) had two open defects:

1. **Nettuno could not satisfy its plan contract.** The itemized contract
   (4×`createPhase` + 12×`createTask` + 1×`createMilestone` = 17 sequential
   tool calls) exceeded what composer-2.5 reliably emits in one turn (≤7 of
   17 persisted in the Pass 3 live tests) — and structurally exceeded the
   runtime budgets anyway (CLI council default `maxToolCallsPerTurn` 15,
   AgentHarness `MAX_TOOL_LOOP_ITERATIONS` 12). Opzione B disabled the retry
   for Nettuno and delegated to a workspace script.
2. **The workspace post-processor produced 4 generic tasks instead of 12.**
   `complete-design.mjs` mapped tasks by hard-coded phase-ID keys that
   drifted from the ids the council actually generated (HANDOFF §4.1), and
   the script itself was unversioned per-workspace (§5.3).

Secondary defects found during the fix:

- Provider schema ↔ stub mismatches: `createTask` schema did not declare
  `fileRefs`/`acceptance`/`qaScenario` (the exact fields Nettuno's prompt
  demands), `createMilestone` lacked `targetVersion`, and
  `linkDocuments`/`getDocumentBacklinks` advertised arg names
  (`sourceId`/`targetPathOrTitle`, `id`) the stubs rejected.
- `createDocument` slugified filename-style titles ("risks.md" →
  `docs/risks-md.md`), producing the duplicated artifacts of HANDOFF §5.1.
- `cli-workspace-complete-design-hook.test.ts` interpolated a raw Windows
  path into generated JS source (invalid escape sequences on win32).

## Fix

### 1. `createPlan` batch tool (root cause)

New workspace stub (`src/cli/workspace/stubs.ts`): ONE call persists the
whole plan — phases with nested tasks + milestone — atomically. Idempotent
(dedupe by phase id and phase+title), merges with partial itemized runs.
JSON schema in `packages/core/src/agents/toolSchemas.ts`; added to the
`project-planner` skill's `requiredTools`.

The itemized stubs now delegate to shared record helpers
(`addPhaseRecord`/`addTaskRecord`/`addMilestoneRecord`) so both paths
produce identical records and files.

### 2. Nettuno contract rewritten + retry re-enabled

`roles.ts`: the design-phase block now presents ONE `createPlan` call as
the PREFERRED path (worked example with the nested shape) and keeps the
itemized tools as FALLBACK.

`councilApi.ts`:

- `DESIGN_PHASE_REQUIREMENT_SETS` — OR-of-sets requirements. Nettuno is
  satisfied by `createPlan ≥ 1` (preferred) OR the legacy itemized trio
  (so strong models emitting itemized calls are not flagged).
- `DESIGN_PHASE_REQUIREMENTS` is now derived as the preferred set — the
  forced retry for Nettuno therefore advertises ONE tool with a 1-call
  budget, the same shape that already works for Minosse/Lucifero.
- `NON_RETRY_AGENTS` is empty (mechanism kept for future opt-outs).
- New pure helper `checkMemberToolEmissionSets`.

### 3. Built-in deterministic complete-design fallback

New `src/cli/workspace/completeDesign.ts`: guarantees ≥3 tasks per phase
(specify → implement → verify, derived from the REAL phase name/description
— phase-ID drift impossible by construction) and ≥1 milestone. Runs through
the same workspace stubs the council uses.

`postCouncilHook.ts` resolution order: a workspace-local
`complete-design.mjs` still wins (curated domain templates); otherwise the
built-in fallback runs. `ZELARI_COMPLETE_DESIGN=0` disables both.

### 4. Schema/stub alignment + title normalization

- `createTask` schema: + `fileRefs`, `acceptance`, `qaScenario`.
- `createMilestone` schema: + `targetVersion`.
- `linkDocuments` stub accepts `sourceId`/`targetPathOrTitle`/`targetId`
  aliases; `getDocumentBacklinks` accepts `id`.
- `createDocument` strips a trailing `.md`/`.markdown` from the title
  before slugifying.

## Defense in depth (design-phase bundle completeness)

1. Prompt: Nettuno anchored to ONE `createPlan` call.
2. Schema: full nested JSON schema, so the model does not guess the shape.
3. Runtime: post-condition check + 1-call forced retry on `createPlan`.
4. Post-processor: built-in fallback tops up to 3 tasks/phase + milestone.

Even in the worst case (model emits phases only, retry fails), the bundle
ends with N phases × 3 tasks + 1 milestone.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run` — **919/919 green** (was 907; +12 new/updated).
- Updated: `cli-councilToolEmission.test.ts` (NON_RETRY empty, requirement
  sets), `core-roles-workspaceToolsPrompt.test.ts` (createPlan anchor),
  `cli-workspace-complete-design-hook.test.ts` (built-in fallback incl. the
  HANDOFF §4 scenario: 4 phases + 1 task → 12 tasks), `cli-workspace-stubs.test.ts`
  (createPlan batch/idempotency/merge, `.md` title strip, schema arg
  aliases), `cli-workspace-toolRegistry.test.ts` (10 stubs).

## Live-validation target (next session, needs a workspace + API key)

Wipe `.zelari/` in a design-phase workspace, run the council with
`COUNCIL_MODEL=composer-2.5`, expect: Nettuno emits `createPlan` (main turn
or retry) → plan.json with 4 phases / 12 tasks / 1 milestone; no
`docs/risks-md.md`/`docs/synthesis-md.md` duplicates; if the model still
under-delivers, `[post-hook] builtin complete-design: +N tasks` covers it.
