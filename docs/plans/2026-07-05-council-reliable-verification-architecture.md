# Council reliable verification architecture (v0.9.x)

> **Goal:** obtain verified, reliable council output on **real multi-file projects**, not just the mono-file TESTMCP case. The TESTMCP case (index.html without build) is the minimal regression fixture; a multi-file fixture with build is also needed.

## Problem

The v0.8.0 verification gate assumes "Lucifero implements -> then it gets verified" and uses bespoke regex checks (motion/CSS). In reality:

1. In implementation mode the **first specialist (Caronte) implements** immediately; every member edits the same file -> multi-writer chaos, violations accumulating across turns.
2. The "done" signal comes from the **model's text**, not from deterministic truth.
3. The checks are **specific to the HTML/CSS domain** -> they do not scale to other languages/projects.
4. The micro-gate is hooked **only to the chairman's writes** -> it reports Caronte's violations late, repeated, mislabeled as `[error]`, and without fixing them. `luciferWriteCount === 0` -> false `DEGRADED_RUN`.

## Principle

**Deterministic truth comes from the project, not the model.** On a real project the reliable signal is its own build system (`tsc`/`test`/`lint`/`build`) run on the diff - not a custom regex. Effectiveness at scale = **a single implementer** + **diff-scoped verification** + **a bounded fix loop**.

## Target architecture

```
DESIGN (council 6 = breadth)         -> plan.json + nfr-spec (artifacts)
      |
IMPLEMENT (ONE implementer only)     -> Lucifero writes; specialists READ-ONLY (advisors)
      |
DETERMINISTIC GATE (ground truth):
   1. projectSmoke: typecheck/test/build        <- PRIMARY, scales to any project
   2. domain-check (motion/NFR regex)            <- optional: only if nfr-spec asks or there is no build
      | FAIL -> inject the RAW failure output -> targeted fix turn (cap 2-3) -> re-gate
      v PASS
VERIFIED = gate PASS (not the synthesis text). readyToCommit driven by the gate.
```

The unit of work on large projects = **the plan-task** (the phases/tasks Nettuno produces), not "everything in one turn": small diffs, fast gate, tractable fix loop.

## Increments (merge order)

### Increment 1 - Read-only specialists, Lucifero sole implementer   <- THIS PR
**Files:** `packages/core/src/council/modeBanners.ts`, `packages/core/src/agents/councilApi.ts`, `tests/unit/`.
- `councilModeBanner(runMode, { isImplementer })`: advisor banner ("analyze/plan, do NOT write files") vs implementer ("you are the one implementing").
- `restrictImplementationWrites(toolNames, { runMode, isImplementer })`: removes `write_file`/`edit_file` from non-implementers in implementation mode (specialists inherit writes via skills - filter on the result of `computeAgentTools`).
- Apply the filter to specialists; the chairman keeps writes.
- Side effect: `luciferWriteCount` becomes real -> **eliminates the false DEGRADED_RUN** without touching the detection.

### Increment 2 - Primary gate = projectSmoke, optional domain-check
- Promote `runProjectSmoke` (already in `src/cli/workspace/projectSmoke.ts`) to the main post-implementation check; regex checks become active only if `nfr-spec` requires them or there is no build.
- `readyToCommit`/`verified` derive from the gate PASS, not the claim.

### Increment 3 - Micro-gate de-noising
- Emit a warning ONCE, `severity:'warn'` (not `console.warn` + an `error` event), deduplicated; no re-scan on every write.

### Increment 4 - Fix loop with the raw failure
- On gate FAIL, inject the real output (tsc/test/violations) into a targeted fix turn of the implementer; reuse `applyRetryIfMissing`; cap 2-3.

### Increment 5 - createNfrSpec schema + multi-file fixture
- Give `createNfrSpec` a real parameter schema (today `parameters: []` -> skipped).
- Add a multi-file regression fixture with `package.json` + build, alongside TESTMCP.

## End-to-end verification
- `npm run typecheck` + `npx vitest run` green.
- New tests: per-role banner, `restrictImplementationWrites`, and (later increments) smoke-as-primary, warning dedup, fix loop.
- TESTMCP replay: no false DEGRADED when Lucifero implements; on a fixture with build, the gate reflects the real build PASS/FAIL.