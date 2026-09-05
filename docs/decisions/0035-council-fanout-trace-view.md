# ADR-0035 - Parallel council fan-out + trace view

> **Renumbering note (2026-09-04):** this ADR was historically the second
> file numbered `0015` (collision with `0015-companion-host-serve.md`). The S6
> triage (t37) renumbered it **0035** to remove the ambiguity; content unchanged.

- **Status:** Accepted (Phase A implemented; Phase B deferred)
- **Proposed:** 2026-07-20
- **Author:** Zelari Code (PLAN phase)
- **Inspiration:** From Loop Engineering to Graph Engineering (Carlos Perez/@IntuitMachine, Jul 2026) - *"graphs force you to admit how much of the workflow you haven't modeled yet"*; divide -> communicate -> synchronize.
- **Depends on:** `MemberCostTracker` (`src/cli/councilCost.ts`), `SliceRunResult`/`MissionState` (`src/cli/zelariMission.ts`), `checkpointManager.ts` (`src/cli/checkpoint/`).

## Context

Two faces of the same coin, both surfaced by the confrontation with "Graph
Engineering". zelari-code has a **stable org-graph** (the 6 fixed members: Charon -> Lucifero) but hides two weaknesses compared to a real execution graph:

### 1. Sequential specialists (missing divide -> synchronize)

Council members run **in sequence**, not in parallel. Confirmed in the code, an explicit comment in `councilCost.ts:100`:

```ts
/** Total wall-clock time across all members. Note: this is sum-of-mems,
 *  not elapsed council time (specialists run sequentially). */
totalDurationMs(): number { ... }
```

The current flow: `dispatchCouncil` (`councilDispatcher.ts:86`) -> `runCouncilPure` (package `@zelari/core/council`) orchestrates the members **one after the other**. "Graph engineering" insists that the independent branches of a DAG should run in parallel (divide), communicate at the sync point (communicate), then proceed (synchronize).

### 2. No per-node observability (the visible "graph" is missing)

`MemberCostTracker` collects **extremely rich** data for every member (`councilCost.ts:21-38`):

```ts
export interface MemberCost {
  memberId: string;       // 'charont' | 'nettun' | 'minos' | 'lucifer' ...
  name: string;           // 'Caronte'
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;     // this member's latency
  toolCalls: number;      // tool_execution_start events
  errored: boolean;       // this branch diverged/failed
}
```

and already serializes it cleanly via `toJSON()` -> `{ ts, costs[] }`. But this data **never reaches an inspection interface**:

- `SliceRunResult` (`zelariMission.ts:47-61`) reports `completionOk`, `writeCount`, `degraded` - **but NOT per-member costs**.
- No `.zelari/trace/<missionId>.json` is persisted.
- No `/trace` command or `zelari-code trace show` exists.
- `MissionState` (`zelariMission.ts:32-44`) has no trace field.

The data exists; its **surfacing** is missing. That is exactly the gap between "a loop that runs" and "a graph you can debug".

## Decision

It splits into **two independent phases**, because they have very different risk/opportunity. **Phase A first** (low risk, high value, unlocks the judgment on Phase B).

### Phase A - Trace View (implement now)

Collect, persist and render the execution graph that **already exists in the data** but is not surfaced:

1. **Extend `SliceRunResult`** (`zelariMission.ts:47`) with `costs?: MemberCost[]`. The driver (`runHeadlessZelari`, which already creates the tracker in the council) passes `tracker.finalize()` in each slice's result.

2. **Extend `MissionState`** (`zelariMission.ts:32`) with `trace?: SliceTrace[]` where `SliceTrace = { sliceId, iteration, runMode, costs: MemberCost[], completionOk, degraded }`. `runZelariMission` aggregates per-slice costs at every iteration.

3. **Persist** `.zelari/trace/<missionId>.json` with the full graph: per slice -> members (in execution order), tokens, USD cost (via `calculateCost` from `modelPricing.ts`), latency, error, degraded flag. This file is the base of every visualization.

4. **New command** `/trace` (TUI) and `zelari-code trace show <missionId>` (headless): they render the execution DAG as a structured list (ASCII or JSON). Shows: who ran, in what order, what it cost, where it diverged (`errored`/`degraded`).

**Result:** a concrete answer to *"where did the plan diverge?"* without digging through logs.

### Phase B - Parallel Fan-Out (DEFERRED - not active work in this ADR)

Parallelize the **independent** council members. Identified but not implemented now, for three reasons:

1. **The dependency graph is today IMPLICIT** in the sequential order. To parallelize it must be made explicit: who can run in parallel, who must wait. Minosse judges **after** the specialists; Lucifero synthesizes **at the end**. The graph is a DAG, not a set - not everything is parallelizable.
2. **State conflict**: parallel specialists writing on the same working tree step on each other. It would require multiple `git worktree add` (an extension of `checkpointManager.ts`, which today operates on a single repo via git plumbing: `createCheckpoint`/`restoreCheckpoint`).
3. **Non-determinism in accumulation**: durable state (Palmer) is sequential by construct; parallelizing it requires redefining the merge model.

**Unlock criterion for Phase B:** implement only if Phase A (trace view) shows that a mission's bottleneck is **really** the sequential members' time, not the number of iterations or the verifier's quality.

## Consequences

**Phase A (now):**
- Immediate observability: debugging *"Minosse rejected slice 3 costing 12k tokens - why?"* becomes a `cat .zelari/trace/<id>.json`.
- Zero functional risk: the data is already collected; only persistence + render are added. The loop's semantics do not change.
- Base for future improvements: the JSON trace also feeds the budget cap (ADR-0013) and potential dashboards.

**Phase B (deferred):**
- Potential speedup (N parallel specialists -> wall-clock ~ max instead of sum), BUT it introduces non-determinism and conflicts.
- **Not done until** Phase A quantifies the win.

## Alternatives considered

1. **Trace in the existing stderr/log.** Rejected: not structured, not queryable, lost at session end. Persisted per-mission JSON preferred.
2. **Parallelize everything now (Phase B first).** Rejected: high risk, unproven payoff. Phase A first is needed to *measure* whether sequential is really the problem.
3. **Trace as an event in the existing BrainEvent stream.** Considered: the council already emits events (`onCouncilStatus`). But the per-mission trace needs persistence beyond the session (post-mortem debugging), so a JSON file is more suitable than an ephemeral event. Events can *feed* the file, but the file remains the source of truth.

## Concrete integration points (Phase A)

| File | Change | Effort |
|---|---|---|
| `src/cli/zelariMission.ts:47` (`SliceRunResult`) | add `costs?: MemberCost[]` | XS |
| `src/cli/zelariMission.ts:32` (`MissionState`) | add `trace?: SliceTrace[]` + type | S |
| `src/cli/zelariMission.ts:200` (`runZelariMission`) | aggregate `result.costs` into `state.trace` at every iter | S |
| `src/cli/runHeadless.ts:996` (where `sliceResult` is built) | pass `tracker.finalize()` in `costs` | S |
| new `src/cli/traceStore.ts` | `saveTrace(missionId, trace)`, `loadTrace(missionId)` -> `.zelari/trace/<id>.json` | S |
| new `src/cli/slashHandlers/trace.ts` | `/trace` command | S |
| `src/cli/main.ts` (help) | `trace show <id>` subcommand | S |
| `modelPricing.ts:112` (`calculateCost`) | already exists - enriches the trace with USD | - |

**Proposed types:**

```ts
export interface SliceTrace {
  sliceId: string;
  iteration: number;
  runMode: CouncilRunMode;
  costs: MemberCost[];      // per-member, in execution order
  totalCostUsd?: number;    // via calculateCost
  completionOk: boolean;
  degraded?: boolean;
  startedAt: string;
  durationMs: number;
}
```

**Acceptance tests (Phase A):**
- After a mission, `.zelari/trace/<missionId>.json` exists and contains one entry per slice with per-member costs.
- `/trace` renders the member order + `errored`/`degraded` flags.
- A slice where Minosse returns `errored: true` is visible in the trace.
- The trace includes `totalCostUsd` (recall ADR-0013 budget cap: same data).