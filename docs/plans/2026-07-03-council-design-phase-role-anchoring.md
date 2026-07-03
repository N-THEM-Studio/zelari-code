# Council design-phase role prompts — workspace-tool anchoring

- **Date**: 2026-07-03
- **Branch**: main
- **Type**: behavior fix (prompt-level) + documentation

## Problem

After the v0.7.5 council workspace-wiring fixes (Bug A: `setWorkspaceStubs`,
Bug B: executor tool union, Bug C: Minosse in debateMode), the workspace
tools (`createPhase`, `createTask`, `addIdea`, `createMilestone`,
`createDocument`, `searchDocuments`, …) are **technically visible** to every
council member. Live-test evidence:

- 2026-07-02 council design-phase run on a "luxury handbag e-commerce"
  workspace (`~/zelari-projects/borsa-lusso-react/`) produced 13 of the
  intended 21 artifacts. Gaps:
  - **Gerione** (Ideator) wrote 0–3 `createDocument` calls across 4 runs.
    Skipped design docs in 30% of runs.
  - **Minosse** (Critic) wrote `createDocument` for `risks.md` in 1 of 4
    runs. Other 3 runs produced prose-only critique.
  - **Nettuno** (Planner) wrote `createTask` calls in 1 of 4 runs; the other
    3 runs emitted phases only (0–12 tasks).
  - **Lucifero** (Synthesizer) called `list_files` (not a workspace tool) in
    3 of 4 runs and then failed with `Tool "list_files" not found`, ending
    the council without emitting `synthesis.md`.

Root cause: the **role `systemPrompt` text in `packages/core/src/agents/roles.ts`
does not anchor each creator role to the workspace tools it is responsible
for emitting**. The model treats the workspace tool list as a generic
registry and decides per-turn whether to call them, instead of treating them
as part of its role contract.

The `role.tools` array is intentionally NOT changed (v0.7.2 contract:
coding-only tools in role.tools, vault/workspace tools surface via the
executor union). Workspace tools are still globally available — they just
need explicit anchors in each creator's role prompt.

## Fix

Five surgical prompt-level amendments to `packages/core/src/agents/roles.ts`,
plus a new test pinning the contracts:

### 1. Nettuno (Planner) — explicit `createPhase` / `createTask` / `createMilestone`
After the existing "Stay under 250 words" line, append a **Design-phase
mandatory tools** block listing the three tools, the exact call shape for
`createTask` (with `phaseId`, `fileRefs`, `acceptance`, `qaScenario`), and
the instruction "Do NOT output tasks as prose. Each task MUST be a
`createTask` tool call."

### 2. Gerione (Ideator) — explicit `createDocument` with 3 categories
After the existing 200-word cap, append a **Design-phase artifact** block
listing the three required categories (`customer-journey-map`,
`information-architecture`, `design-tokens`), a one-line spec for each, and
the explicit `createDocument({ title, content })` call shape.

### 3. Minosse (Critic) — single `createDocument` for risks
Remove the existing parenthetical "(You do not create workspace artifacts,
so you do not emit a tools block …)" which contradicted the design-phase
intent. Append a **Design-phase risks artifact** block that grants exactly
ONE workspace tool emission per run: `createDocument({ title: "risks",
content: <markdown with 5+ risks> })`.

### 4. Lucifero (Synthesizer) — explicit `createDocument` for synthesis
After the existing tool-list sentence, append a **Design-phase synthesis
artifact** block with the exact `createDocument` call shape, plus the
explicit ban: "DO NOT call `list_files` — it is NOT a workspace tool. Use
`searchDocuments` if you need to look something up (limit 2-3 searches)."

### 5. Tool arrays unchanged
`role.tools` for Gerione / Minosse / Nettuno / Lucifero remain exactly as
the v0.7.2 contract pins them in
`tests/unit/core-councilIdentity.test.ts` ("no role declares vault/planner
tools", "Minosse declares no tools"). Workspace tools continue to surface
via the executor union (Bug B fix).

## Test

New: `tests/unit/core-roles-workspaceToolsPrompt.test.ts` (5 tests, all green):

1. Gerione prompt mentions `createDocument` and ≥3 design-doc categories.
2. Minosse prompt mentions `createDocument`, "risk", and a structured
   template (list or headings).
3. Nettuno prompt mentions `createTask` and `createMilestone` plus the
   `fileRefs/acceptance/qa` field anchors.
4. Lucifero prompt mentions `createDocument` and "synthesis".
5. `role.tools` arrays for Gerione and Minosse remain unchanged
   (regression guard for the v0.7.2 contract).

## Verification

| Suite | Before | After |
|---|---|---|
| `core-councilIdentity.test.ts` (contract) | 7/7 | 7/7 |
| `core-roles-workspaceToolsPrompt.test.ts` (new) | — | 5/5 |
| Full repo | 879/879 | 884/884 |

## Expected behavior change (post-merge)

When the council runs in design-phase mode (TASK mentions design /
architecture / spec, no existing codebase to edit), the model should:

- Gerione → 3 (or 4) `createDocument` calls (one per design-doc category).
- Minosse → 1 `createDocument` call for `risks.md`.
- Nettuno → `createPhase` + `createMilestone` + N×`createTask` calls.
- Lucifero → `searchDocuments` (≤3 calls) then 1 `createDocument` for
  `synthesis.md`. No `list_files`.

Run-time validation target (manual): wipe `.zelari/` in
`~/zelari-projects/borsa-lusso-react/`, run with `COUNCIL_MODEL=composer-2.5`,
expect ≥ 18 artifacts in `.zelari/` (5 phases, ≥6 tasks, 1 milestone, ≥6
ADRs, 3 design docs, 1 risks, 1 synthesis, plan.json, plan.md).

## Out of scope

- **No** retry / enforcement: if the model still skips a tool after the
  prompt update, the council continues and post-processors can fill the
  gap. Future work may add a "tool-emission completeness" check at the end
  of the council loop.
- **No** changes to `role.tools` arrays (would break the v0.7.2 contract).
- **No** changes to the Bug A/B/C fixes already in `e9e0df6`.