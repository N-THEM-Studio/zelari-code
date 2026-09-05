# ADR-0013: Budget cap (token/USD) as the third stop-rule of the Zelari mission

- **Status:** Accepted (implemented)
- **Proposed:** 2026-07-20
- **Author:** Zelari Code (PLAN phase)
- **Inspiration:** Loop Engineering (rari/@0xwhrrari, Jun 2026) + From Loop Engineering to Graph Engineering (Carlos Perez/@IntuitMachine, Jul 2026)
- **Depends on:** cost infrastructure already present - `councilCost.ts` (`MemberCostTracker`) and `modelPricing.ts` (`calculateCost`)

## Context

Every reliable agent loop has **three independent stop-rules**
(see "Loop Engineering: Complete Guide", rari/@0xwhrrari):

1. **Success exit** - the verifier confirms the goal.
2. **Iteration cap** (MAX_ITERATIONS) - a stuck loop does not run forever.
3. **Budget cap** - a runaway loop does not burn the entire token/USD spend.

> *"Skipping the iteration and budget caps is how people wake up to a $400 API
> bill and an agent that looped 900 times on an impossible task."*

zelari-code implements **2 of the 3** stop-rules in the mission driver
(`zelariMission.ts`):

| Stop-rule | Where | Status |
|---|---|---|
| Success exit | `if (completionOk) { state.status = 'success'; ... }` (`zelariMission.ts:~395`) | yes |
| Iteration cap | `DEFAULT_MAX_ITER = 6` + `ZELARI_MISSION_MAX_ITER` (`zelariMission.ts:110-116`) | yes |
| Stall detection | `DEFAULT_MAX_STALL = 2` + `noWriteStreak` (`zelariMission.ts:413-443`) | yes (bonus) |
| **Budget cap (token/USD)** | - | **MISSING** |

**The counter already exists, the valve does not.** `MemberCostTracker`
(`councilCost.ts`) accumulates `promptTokens`/`completionTokens`/`durationMs` per
member; `modelPricing.ts:112` exposes `calculateCost(model, prompt,
completion, cached?) -> usd`. But none of this data reaches the `while(true)`
of `runZelariMission` to stop the loop when spend exceeds a cap.

A Zelari mission with `councilSize: 6` and `MAX_ITER = 6` can emit up to
**6 x (5 specialists + Minosse + Lucifero) = ~42 LLM invocations**, each with
its tool-loop (up to `maxToolLoopHardCap`). On grok-4 ($3/$15 per 1M) that is
potentially tens of dollars in a single mission with no brake other than the
iteration count - which does not weigh the *gravity* of each one.

## Decision

Add a third stop-rule to the mission driver: a cumulative cap on
**total tokens** and/or **USD** spent since the start of the mission, checked at
every iteration of the `while(true)`. The mission ends with `status: 'stopped'`
(a new sub-reason `budget-exceeded`) when the cap is reached.

### 1. Environment variables (new inputs)

```
ZELARI_MISSION_MAX_COST=5.00      # mission cumulative USD (default: off)
ZELARI_MISSION_MAX_TOKENS=2000000 # cumulative tokens (default: off)
```

Both optional. If unset, the stop-rule is disabled (current behavior, zero
breaking change). They can be set together: the first one hit wins.

### 2. Resolution schema (mirrors `resolveMaxIterations`)

In `zelariMission.ts`, next to `resolveMaxIterations` (line 113):

```ts
export function resolveMaxCost(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ZELARI_MISSION_MAX_COST;
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveMaxTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.ZELARI_MISSION_MAX_TOKENS;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
```

### 3. `SliceRunResult` extension (backward-compatible)

In `zelariMission.ts`, interface `SliceRunResult` (line ~37), add optional
fields:

```ts
export interface SliceRunResult {
  // ... existing fields ...
  /** Total tokens (prompt+completion) consumed by this slice. */
  costTokens?: number;
  /** Estimated USD cost of this slice. */
  costUsd?: number;
}
```

`undefined` = the driver does not report them -> stop-rule disabled (backward
compat, like `writeCount`).

### 4. Accumulation and check in the loop

In `runZelariMission` (line ~206), after `maxStall`:

```ts
const maxCost = resolveMaxCost(deps.env);
const maxTokens = resolveMaxTokens(deps.env);
let cumulativeCost = 0;
let cumulativeTokens = 0;
```

After `result = await deps.runSlice(...)` (line ~320), accumulate:

```ts
if (typeof result.costTokens === 'number') cumulativeTokens += result.costTokens;
if (typeof result.costUsd === 'number') cumulativeCost += result.costUsd;
```

Add the stop-check **after** accumulation, **before** the final
`writeMissionState` of the success/continue branch (i.e. after handling the
single step, before the next turn of the `while`). Place it together with
stall-detection:

```ts
// Budget cap: third stop-rule (Loop Engineering).
if (
  (maxCost !== undefined && cumulativeCost >= maxCost) ||
  (maxTokens !== undefined && cumulativeTokens >= maxTokens)
) {
  state.status = 'stopped';
  state.updatedAt = now().toISOString();
  await writeMissionState(deps.projectRoot, state);
  const reason = maxCost !== undefined && cumulativeCost >= maxCost
    ? `budget USD ${formatCost(cumulativeCost)} >= ${formatCost(maxCost)}`
    : `token ${formatTokens(cumulativeTokens)} >= ${formatTokens(maxTokens!)}`;
  deps.emit(
    `[zelari] stopped: ${reason}. ` +
    'Set ZELARI_MISSION_MAX_COST / ZELARI_MISSION_MAX_TOKENS higher, ' +
    'or use a cheaper model. State saved in .zelari/mission-state.json',
  );
  return state;
}
```

### 5. Wiring the cost from the slice runner

`missionSlice.ts` (`runAgentMissionSlice`) already has access to the
`AgentHarness` and emits `tool_execution_*`/`message_end`. Two options:

- **Option A (simple):** the slice runner estimates `costTokens` from the
  `usage` of the last `message_end` and `costUsd` via
  `calculateCost(model, ...)`, and puts them in `SliceRunResult`. It does not
  count secondary tool-calls but is sufficient as a guardrail.
- **Option B (precise):** inject a shared `MemberCostTracker` into the
  mission deps; the slice runner feeds it with every event. The loop reads
  `tracker.totalTokens()`. More precise but touches the signature of more
  functions.

**Option A recommended** for the first release (an anti-spend guardrail, not
exact accounting); Option B as a follow-up if reporting is needed.

### 6. Persistent `MissionState`

Add to `MissionState` (line ~26) for observability/resume:

```ts
/** Cumulative cost (USD) and tokens at the last persistence. */
cumulativeCostUsd?: number;
cumulativeTokens?: number;
```

Update them in `writeMissionState` together with `state.iteration`.

## Alternatives considered

- **Per-slice cap instead of per-mission:** rejected. A single council run can
  legitimately cost a lot (design-phase + implementation); the cap must measure
  the *total mission spend*, not the single step.
- **Token-only cap, no USD:** rejected. The user thinks in dollars; the
  `modelPricing.ts` module exists for that. Offer both (the user chooses).
- **Hard-abort of the whole CLI instead of `status: 'stopped'`:** rejected for
  consistency with the other stop-rules (iteration cap and stall both do
  `state.status = 'stopped'`/`'stalled'` + handoff state in
  `.zelari/mission-state.json`, not a crash). The user can `/resume`.
- **A model checking itself as a "cost judge":** rejected. The cap is
  deterministic (arithmetic sum vs. threshold), needs no LLM - consistent with
  the "deterministic verifier > model self-grading" principle.

## Consequences

**Positive**
- The third stop-rule completes the Zelari loop's safety triangle: the user
  can leave a mission unattended knowing the spend cap is guaranteed
  ("runs while you sleep").
- Aligns zelari-code with the emerging "loop engineering" vocabulary with a
  concrete, not nominal, feature.
- `MissionState` becomes self-documenting on costs (useful for future
  `/council-cost` style reporting).

**Negative / risks**
- Option A underestimates the real cost (ignores secondary tool-calls and
  cache-break). Mitigated: it is a *guardrail*, not a financial report; the
  user sets the cap with margin.
- An imprecise estimate could stop a mission too early or too late.
  Mitigated: default `off` -> zero regression for those who do not set the
  env vars.

## TODO

- [ ] Implement `resolveMaxCost` / `resolveMaxTokens` in `zelariMission.ts`.
- [ ] Extend `SliceRunResult` and `MissionState` with the cost fields.
- [ ] Cost wiring in `runAgentMissionSlice` (`missionSlice.ts`, Option A).
- [ ] Stop-check in the `while(true)` of `runZelariMission`.
- [ ] Unit tests (`zelariMission.test.ts`): mission stops at the USD cap;
      mission stops at the token cap; mission without env vars does not stop
      (backward compat); `resolveMaxCost`/`resolveMaxTokens` parsing edge cases.
- [ ] Document the env vars in `README.md` (Features table) and `docs/GUIDA.md`.
- [ ] Update `AGENTS.MD` Open Questions / Decisions section.