# Zelari 2.5+ - Integrated implementation plan
## Harness Retention, Regression Safety & Resource-Aware Execution

**Baseline:** Zelari 2.5.0  
**Suggested target:** Zelari 2.6 for the core; 2.7+ for the later experiments  
**Status:** consolidated operational proposal

---

# 1. Goal

The next Zelari cycle should not add new agents or new modes on principle.

The priorities are two:

1. **make the evolution of the harness itself safe and measurable**;
2. **make the agent aware of remaining resources without losing host-side control**.

The target system must guarantee simultaneously:

```text
new capability acquisition
+
historical capability retention
+
verified completion
+
resource-aware execution
+
cost/performance measurement
```

Guiding principle:

> **A new version of Zelari must demonstrate both what it has learned to do and what it has not forgotten, and must spend resources in a way consistent with the probability of reaching a verified solution.**

---

# 2. What to implement

## Track A - Harness evolution safety

1. **Harness Manifest**
2. **Historical Anchor Set**
3. **Harness Regression Gate**
4. **First-class TaskContract**
5. **Harness Change Classification**
6. **Eval Result Store**

## Track B - Resource-aware execution

7. **Central ResourceBudget / ResourceLedger**
8. **Model-visible latest resource snapshot**
9. **Verification Budget Reserve**
10. **Budget-aware continuation / repair / pivot**
11. **Unified Cost Metric in evals**

## Later tracks, conditional on benchmarks

12. Gauntlet piece budget allocation
13. Model/profile-specific budget curves
14. `--effort efficient|balanced|thorough`
15. Guarded project memory
16. Candidate router optimization
17. Adaptive Eval / SPADE integration

---

# 3. What NOT to implement now

Not entering the 2.6 cycle:

- self-modification of the harness in production;
- full BATS;
- general-purpose tree search;
- automatic continue-after-PASS;
- auto-installation of skills;
- self-modifying router;
- RL/self-play runtime;
- new Council roles;
- new agents;
- general-purpose plugin framework;
- a new compaction system;
- a mandatory database;
- prompt auto-update on `main`.

Zelari 2.5 already has a compaction better suited to coding than the budget-aware paper's one.

---

# 4. Priorities

| Priority | Feature | Value | Complexity | Target |
|---|---|---:|---:|---|
| P0 | Harness Manifest | Very high | Low/Medium | 2.6 |
| P0 | Historical Anchors | Very high | Medium | 2.6 |
| P0 | Harness Regression Gate | Very high | Medium | 2.6 |
| P0 | ResourceBudget / ResourceLedger | Very high | Medium | 2.6 |
| P0 | Verification Budget Reserve | Very high | Medium | 2.6 |
| P1 | Model-visible budget snapshot | Very high | Low | 2.6 |
| P1 | First-class TaskContract | High | Medium | 2.6 |
| P1 | Unified Cost Metric | Very high | Low | 2.6 |
| P1 | Budget-aware repair/pivot | High | Medium | 2.6 |
| P1 | Harness Change Classification | High | Low | 2.6 |
| P2 | Eval Result Store | Medium/High | Low | 2.6 |
| P2 | Gauntlet piece allocation | High | Medium | 2.7 |
| P2 | Model-specific budget curves | High R&D | Medium | 2.7 |
| P2 | `--effort` presets | Medium | Low | after data |
| P2 | Guarded Memory | High | Medium/High | post-2.6 |
| P2 | Candidate Router Optimization | Medium/High | High | post-2.6 |
| P2 | Adaptive Eval Integration | High R&D | High | separate |

Suggested order:

```text
Harness Manifest
      v
Historical Anchors
      v
Regression Gate
      v
ResourceBudget / Ledger
      v
resource.snapshot
      v
Verification Reserve
      v
TaskContract
      v
Budget-aware continuation
      v
Unified Cost Metric
      v
Targeted anchor selection
      v
Extended R&D
```

---

# 5. Target architecture

```text
                         USER TASK
                             |
                             v
                        TaskContract
                             |
                  +----------------------+
                  |                      |
                  v                      v
             Harness Manifest      ResourceBudget
                  |                      |
                  |                ResourceLedger
                  |                      |
                  +----------+-----------+
                             v
                     Runtime / AgentHarness
                             |
                  +----------+-----------+
                  v          v           v
              ToolRegistry  Session  Verification
                  |          Spine       Engine
                  |            |           |
                  +------------+-----------+
                               v
                      CompletionPolicy
                               |
                     verified outcome
                               |
                               v
                        Eval / Anchors
                               |
                               v
                      Regression Gate
```

---

# 6. Workstream A - Harness Manifest

## 6.1 Problem

Zelari's behavior depends on more elements than just the model/profile:

- system prompt;
- Kraken/Gauntlet/Council/Mission prompt;
- tool descriptions;
- skill contents;
- routing;
- criteria pack;
- verification/completion policy;
- compaction policy;
- behavioral feature flags;
- resource policy.

Two runs with the same model can therefore be semantically different.

## 6.2 Goal

Create a canonical, versioned, hashable representation of the effective harness.

## 6.3 Contract

```ts
interface HarnessManifestV1 {
  schemaVersion: 1;

  profile: {
    id: string;
    phase: "plan" | "build";
    hash: string;
  };

  prompts: {
    kraken?: string;
    gauntlet?: string;
    council?: string;
    mission?: string;
  };

  capabilities: {
    toolManifestHash: string;
    skillManifestHash: string;
  };

  policies: {
    routingHash: string;
    verificationHash: string;
    completionPolicyHash: string;
    compactionHash: string;
    resourcePolicyHash: string;
  };

  runtime: {
    coreVersion: string;
    cliVersion: string;
  };
}
```

The behavioral fields contain canonical hashes, not raw text.

## 6.4 Canonical hash

```ts
function hashHarnessManifest(
  manifest: HarnessManifestV1
): string
```

Requirements:

- canonical serialization;
- stable order;
- no timestamps;
- no volatile runtime values;
- same harness -> same hash.

## 6.5 Session integration

New state-only event:

```text
session.harness_manifest
```

```ts
{
  manifest: HarnessManifestV1;
  manifestHash: string;
}
```

## 6.6 Resource policy in the manifest

The budget policy is behavioral and must influence the manifest.

Example:

```ts
resourcePolicyHash = hash({
  maxToolCalls: 40,
  verificationReserve: 6,
  repairReserve: 4,
  wallClockMs: 900000
})
```

## 6.7 Suggested files

```text
packages/core/src/runtime/
  |- harnessManifest.ts
  |- profiles.ts
  |- index.ts

packages/core/src/session/
  |- types.ts

src/cli/
  |- harnessManifest.ts
```

## 6.8 Tests

- same harness -> same hash;
- prompt changes -> different hash;
- tool description changes -> different hash;
- resource policy changes -> different hash;
- manifest rebuildable after resume.

## 6.9 Exit criteria

- every new session records the manifest;
- every eval outcome is attributable to a precise manifest;
- behavioral variations are traceable.

---

# 7. Workstream B - Historical Anchor Set

## 7.1 Goal

Build a small, stable, verifiable suite of capabilities Zelari must not lose.

Question:

> "Did the candidate version break tasks the baseline already solved?"

## 7.2 Structure

```text
eval/anchors/
  |- local-bugfix/
  |- multi-file/
  |- verification/
  |- compaction/
  |- recovery/
  |- resource-budget/
  |- kraken-delegation/
  |- gauntlet/
  |- council/
  |- mission/
```

## 7.3 Anchor manifest

```yaml
id: auth-refresh-regression
version: 1

profile: kraken/v1
phase: build

task: >
  Fix expired refresh token handling without changing password validation.

success:
  - command: npm test -- auth
  - command: npm run typecheck

budget:
  max_tool_calls: 40
  verification_reserve: 6
  max_tokens: 120000
  max_wall_ms: 900000

tags:
  - auth
  - local-bugfix
  - regression
```

## 7.4 Mandatory properties

Every anchor:

- deterministic setup;
- versioned task;
- mechanically verifiable success;
- tool/token/time limits;
- restorable fixture;
- no secrets;
- no dependency on user state.

## 7.5 Tiers

### Tier 0
Fast smoke tests, PR blocking.

### Tier 1
Core retention, merge/release gate.

### Tier 2
Expensive/provider-sensitive, nightly/RC.

## 7.6 Bootstrap

15-25 initial anchors:

```text
5 local bugfix
4 multi-file
3 verification/evidence
3 compaction/recovery
2 resource-budget
3 Kraken delegation
2 Gauntlet
2 Mission
1 Council
```

## 7.7 Baseline

```ts
interface AnchorBaseline {
  anchorId: string;
  harnessManifestHash: string;

  result: "pass" | "fail" | "blocked";
  verified: boolean;

  cost: RunCost;

  recordedAt: string;
}
```

Golden = verified outcome + cost metrics, not narrative LLM output.

---

# 8. Workstream C - Harness Regression Gate

## 8.1 Goal

Compare:

```text
baseline H
vs
candidate H'
```

on:

- capability acquisition;
- historical retention;
- validity;
- resource efficiency.

## 8.2 Result

```ts
interface HarnessEvalResult {
  manifestHash: string;

  currentSuite: {
    passed: number;
    total: number;
  };

  anchors: {
    passed: number;
    total: number;
    regressions: AnchorRegression[];
    improvements: AnchorImprovement[];
  };

  validity: {
    passed: boolean;
    violations: string[];
  };

  cost: RunCostSummary;
}
```

## 8.3 Retention policy

```ts
interface HarnessRetentionPolicy {
  maxRegressedAnchors: number;
  minCurrentImprovement?: number;

  maxCostPerSolveIncreasePct?: number;
  maxWallTimeIncreasePct?: number;

  requireValidityPass: boolean;
}
```

## 8.4 Presets

### Stable

```ts
{
  maxRegressedAnchors: 0,
  requireValidityPass: true
}
```

### Experimental

```ts
{
  maxRegressedAnchors: 1,
  requireValidityPass: true
}
```

### Research

```ts
{
  maxRegressedAnchors: 2,
  requireValidityPass: true
}
```

## 8.5 Commit rule

```text
validity = PASS
AND
regressions <= retention budget
AND
new capability improvement >= threshold, if configured
AND
cost efficiency within policy, if configured
```

## 8.6 Report

```text
Harness candidate: 8f4b...

New target suite
18/20 -> 20/20
+2

Historical anchors
78/80 -> 77/80
-1

Cost / verified solve
$0.18 -> $0.31
+72%

Retention budget
0

RESULT:
REJECT
```

---

# 9. Workstream D - Central ResourceBudget & ResourceLedger

## 9.1 Problem

Zelari already applies several limits:

- max tool calls;
- max tool-loop iterations;
- Mission budgets;
- Gauntlet rounds/pieces/parallelism;
- wall clock.

But they are mostly distributed **host constraints**.

A central, rebuildable representation of resource state is missing.

## 9.2 Goal

Separate:

```text
budget enforcement
```

from:

```text
budget awareness
```

The host continues to own and enforce the limits.

The model only receives a controlled projection of the remaining budget.

## 9.3 Contract

```ts
interface ResourceBudget {
  toolCalls: {
    limit: number;
    used: number;
    remaining: number;
  };

  wallTime: {
    limitMs?: number;
    elapsedMs: number;
    remainingMs?: number;
  };

  tokens?: {
    softLimit?: number;
    used: number;
    remaining?: number;
  };

  reserve: {
    verification: number;
    repair: number;
  };

  phase:
    | "explore"
    | "implement"
    | "verify"
    | "repair";
}
```

## 9.4 Ledger

```ts
interface ResourceLedgerEntry {
  seq: number;
  reason:
    | "tool-call"
    | "model-turn"
    | "verification"
    | "repair"
    | "timeout"
    | "reservation";

  delta: {
    toolCalls?: number;
    tokens?: number;
    wallMs?: number;
  };
}
```

The ResourceLedger is host-owned.

## 9.5 Invariants

- `used <= limit` except for a final hard-limit event;
- `remaining = limit - used`;
- reserve never negative;
- the model cannot mutate the budget;
- ToolRegistry remains the choke point;
- budget state rebuildable from the Session log.

---

# 10. Workstream E - `resource.snapshot` in the Session

## 10.1 Event

```text
resource.snapshot
```

```ts
interface ResourceSnapshotEvent {
  toolCallsUsed: number;
  toolCallsRemaining: number;

  wallMsRemaining?: number;

  verificationReserve: number;
  repairReserve: number;

  phase: "explore" | "implement" | "verify" | "repair";

  pressure:
    | "ample"
    | "normal"
    | "constrained"
    | "critical";
}
```

## 10.2 Projection rule

The ledger keeps all snapshots.

The model surface shows only the latest:

```text
resource.snapshot #1
resource.snapshot #2
resource.snapshot #3
        v
model sees #3
```

## 10.3 Model-visible representation

```text
RESOURCE STATUS
Tool calls: 27 / 40
Remaining: 13
Verification reserve: 6
Pressure: constrained
Phase: implement
```

## 10.4 Frequency

Update at least after:

- a tool batch;
- a phase change;
- a reserve threshold crossed;
- verification start;
- repair start.

---

# 11. Workstream F - Verification Budget Reserve

## 11.1 Problem

A coding agent can burn almost all resources before reaching:

- tests;
- typecheck;
- build;
- diff review;
- repair;
- retest.

This contradicts:

> **done = evidence**

## 11.2 Policy

```ts
interface ResourcePolicy {
  maxToolCalls: 40;

  reserve: {
    verification: 6;
    repair: 4;
  };
}
```

Do not create rigid sub-budgets for each phase.

## 11.3 Enforcement

When:

```text
remaining <= verificationReserve
```

non-essential actions are limited or strongly discouraged.

### Allowed/prioritized

- tests;
- typecheck;
- build;
- diff;
- reading failures;
- targeted repair;
- retest.

### To avoid

- broad exploration;
- speculative research;
- new architecture;
- non-essential delegations.

## 11.4 Hard vs advisory

Suggested initial default:

```text
verification reserve = protected
repair reserve = advisory
```

## 11.5 Completion interaction

If the remaining budget does not allow the required evidence:

```text
CompletionPolicy != PASS
```

Prefer:

```text
BLOCKED / resource exhausted
```

over a false done.

---

# 12. Workstream G - Budget Pressure

## 12.1 States

```ts
type BudgetPressure =
  | "ample"
  | "normal"
  | "constrained"
  | "critical";
```

## 12.2 Semantics

### ample
- useful exploration;
- reasonable alternatives;
- useful delegation.

### normal
- converge;
- reduce speculative research.

### constrained
- close known gaps;
- avoid new scope;
- preserve the verify reserve.

### critical
- verification/repair/finalization;
- or honestly BLOCKED.

## 12.3 Thresholds

Do not copy percentages from other domains.

Derive them from Zelari benchmarks.

First implementation:

```text
policy configurable
```

---

# 13. Workstream H - Budget-aware Continuation / Repair / Pivot

## 13.1 Goal

The budget does not decide the PASS.

It decides **how to spend the remaining resources**.

```text
VerificationEngine
-> deterministic truth

ResourcePolicy
-> next-action feasibility
```

## 13.2 Decision

```ts
type ContinuationDecision =
  | "complete"
  | "repair"
  | "pivot"
  | "hold";
```

```ts
interface ContinuationInput {
  verificationState: VerificationState;
  remainingBudget: ResourceBudget;
  latestGap?: Gap;
  repairHistory: RepairAttempt[];
}
```

## 13.3 Examples

### GAP + ample

```text
23 calls remaining
8 min remaining
-> repair
```

### repeated GAP

```text
same failure repeated 3 times
18 calls remaining
-> pivot
```

### structural GAP + critical

```text
4 calls remaining
-> hold
```

### deterministic PASS

```text
-> complete
```

Do not continue just because budget remains.

## 13.4 Mission

Integrate into the existing continuation policy.

User steer keeps winning.

## 13.5 Gauntlet

Combine:

```text
PASS/GAP/BLOCKED
+
ResourceBudget
```

without changing the authority of the critic or of the CompletionPolicy.

---

# 14. Workstream I - First-class TaskContract

## 14.1 Goal

Gradually stop deducing constraints and criteria from prose.

```text
User prose
   v
TaskContract
   v
goal + constraints + acceptance criteria
```

## 14.2 Contract

```ts
interface TaskContract {
  version: number;

  goal: string;
  constraints: TaskConstraint[];
  acceptanceCriteria: TaskCriterion[];

  source: {
    userSeq: number;
  };
}
```

```ts
interface TaskConstraint {
  id: string;
  text: string;
  source: "user" | "agent-derived";
  required: boolean;
}
```

```ts
interface TaskCriterion {
  id: string;
  text: string;
  source: "user" | "agent-derived";
  required: boolean;

  verificationHint?: {
    kind: "command" | "tool" | "semantic" | "manual";
    value?: string;
  };
}
```

## 14.3 Authority

```text
user > agent-derived
```

A derived criterion cannot:

- contradict a user constraint;
- change the goal;
- remove required criteria.

## 14.4 Events

```text
task.contract
task.contract_updated
```

Append-only.

## 14.5 Compaction

`CompactionStateSnapshot` uses TaskContract first.

Regex extraction remains as compatibility fallback.

## 14.6 Verification

Required criteria enter the same:

```text
VerificationEngine
-> CompletionPolicy
```

## 14.7 Resource integration

TaskContract may expose `risk` in the future, but must not own the budget.

ResourcePolicy stays host-owned.

---

# 15. Workstream J - Unified Cost Metric

## 15.1 Goal

Do not evaluate a harness on solve rate alone.

Measure:

```text
quality
+
cost
+
latency
```

## 15.2 Type

```ts
interface RunCost {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;

  toolCalls: number;

  modelCostUsd: number;
  toolCostUsd?: number;

  wallMs: number;
}
```

## 15.3 Main metrics

```text
Verified Solve Rate
Cost per Verified Solve
Wall Time per Verified Solve
Tool Calls per Verified Solve
```

North-star:

> **cost per verified solved task**

## 15.4 Pareto report

```text
Candidate   Solve   Cost/solve   Wall
A           70%     $0.18        82s
B           72%     $0.37       151s
```

An increase in solve rate does not imply automatic promotion.

---

# 16. Workstream K - Harness Change Classification

## 16.1 Classes

### Behavioral
- prompts;
- tool descriptions;
- routing;
- criteria packs;
- verifier prompt;
- compaction policy;
- resource policy.

### Structural
- Session semantics;
- ToolRegistry;
- CompletionPolicy;
- recovery;
- workspace/runtime seams.

### Cosmetic
- UI copy;
- docs;
- formatting.

## 16.2 Policy

```text
behavioral
-> anchor gate

structural
-> anchor gate + invariants

cosmetic
-> standard CI
```

## 16.3 Manifest diff

```ts
diffHarnessManifest(oldManifest, newManifest)
```

Use the diff for targeted anchors.

---

# 17. Workstream L - Eval Result Store

No mandatory DB.

```text
eval/results/
  <manifestHash>/
    summary.json
    anchors.jsonl
```

```ts
interface EvalRunRecord {
  runId: string;
  manifestHash: string;
  anchorId: string;

  verifiedResult:
    | "pass"
    | "fail"
    | "blocked";

  cost: RunCost;

  resourcePolicyHash: string;
  exitCode: number;
}
```

SQLite only if volumes will require it.

---

# 18. Gauntlet piece budget allocation - later phase

Does not block 2.6.

## 18.1 Type

```ts
interface PieceBudgetHint {
  pieceId: string;
  weight: number;
  minVerificationCalls: number;
}
```

The decomposer can suggest weights.

The host decides the real policy.

> The model proposes priorities; the host owns the resources.

---

# 19. Model/profile-specific budget curves - later phase

Measure:

```text
model x profile x budget
```

Example:

```text
Model A / Kraken
20 calls -> 68%
40 calls -> 80%
60 calls -> 80%

Model B / Kraken
20 calls -> 55%
40 calls -> 70%
60 calls -> 77%
```

Use the data for defaults and future tuning.

---

# 20. `--effort` presets - only after data

Possible future UX:

```text
--effort efficient
--effort balanced
--effort thorough
```

Do not introduce presets before empirical benchmarks.

---

# 21. Guarded Project Memory - later phase

```text
verified successful sessions
      v
candidate lesson
      v
candidate Harness Manifest
      v
Historical Anchors
      v
Regression Gate
      v
commit / reject
```

Memory does not enter automatically.

---

# 22. Candidate Router Optimization - later phase

```text
eval data
v
candidate routing policy
v
new Harness Manifest
v
anchors
v
Regression Gate
v
commit / reject
```

Never self-update in production.

---

# 23. Adaptive Eval / SPADE integration

```text
Adaptive Eval = acquisition
Historical Anchors = retention
Regression Gate = promotion
Unified Cost = efficiency
ResourceBudget = execution discipline
```

Pipeline:

```text
frontier task
      v
candidate improvement
      v
candidate manifest
      v
new-task eval
      v
historical anchors
      v
cost comparison
      v
retention policy
      v
commit / reject
```

---

# 24. Proposed session events

New state-only events:

```text
session.harness_manifest
task.contract
task.contract_updated
resource.snapshot
resource.limit_reached
resource.reserve_entered
```

## 24.1 Invariants

### Harness Manifest
- one active manifest per session start;
- update only via a new event/version.

### TaskContract
- monotonic version;
- valid user source seq.

### Resource
- monotonic used for cumulative resources;
- coherent remaining;
- reserve never negative;
- tool budget not counted twice.

---

# 25. Suggested files

## Core runtime

```text
packages/core/src/runtime/
  |- harnessManifest.ts        NEW
  |- resourceBudget.ts         NEW
  |- resourcePolicy.ts         NEW
  |- profiles.ts               UPDATE
```

## Session

```text
packages/core/src/session/
  |- types.ts                  UPDATE
  |- invariants.ts             UPDATE
  |- modelSurface.ts           UPDATE
  |- taskContract.ts           NEW
```

## Verification / Mission

```text
packages/core/src/verification/
  |- types.ts / engine.ts      UPDATE if needed

packages/core/src/mission/
  |- continuationPolicy.ts     UPDATE
```

## CLI

```text
src/cli/budget/
  |- resourceLedger.ts         NEW
  |- resourceSnapshot.ts       NEW
  |- modelContextBuilder.ts    UPDATE

src/cli/gauntlet/
  |- loop.ts                   UPDATE
  |- policy.ts                 UPDATE

src/cli/kraken/
  |- taskContract.ts           NEW/UPDATE
```

## Eval

```text
tools/eval/
  |- anchorRunner.ts
  |- regressionGate.ts
  |- retentionPolicy.ts
  |- cost.ts
  |- report.ts
  |- targetedAnchors.ts
  |- types.ts
```

---

# 26. Test strategy

## 26.1 Harness Manifest

- deterministic hash;
- resource policy changes the hash;
- prompt/tool change changes the hash;
- resume equality.

## 26.2 ResourceBudget

- decrement tool calls;
- no double-count;
- reserve activation;
- hard limit;
- resume reconstruction;
- model cannot mutate the budget.

## 26.3 Resource snapshot

- only the latest visible;
- old snapshots remain in the ledger;
- compaction preserves the latest state;
- resume produces the same surface.

## 26.4 Verification reserve

- exploration does not consume the protected reserve;
- verify calls allowed;
- insufficient resources -> BLOCKED, not PASS;
- a deterministic PASS also ends with budget left.

## 26.5 Continuation policy

- GAP + ample -> repair;
- repeated GAP + budget -> pivot;
- structural GAP + critical -> hold;
- PASS -> complete.

## 26.6 Historical Anchors

- deterministic setup/reset;
- timeout;
- tool budget;
- verified success.

## 26.7 Regression Gate

- zero-regression stable;
- one-regression experimental;
- validity failure always rejects;
- cost policy violation reported correctly.

## 26.8 TaskContract

- user constraint preserved;
- derived criteria logged;
- user wins conflicts;
- steer versioning;
- compaction preservation.

---

# 27. Benchmark matrix

Build benchmarks over:

```text
model
x
profile
x
resource policy
x
task class
```

## 27.1 Task classes

- local bugfix;
- multi-file change;
- debugging;
- verification-heavy;
- Gauntlet/high-risk;
- Mission/long-horizon.

## 27.2 Policies

```text
budget unaware baseline
budget visible
budget visible + verification reserve
budget visible + reserve + repair/pivot
```

## 27.3 Metrics

- verified solve rate;
- tool calls;
- input/output tokens;
- cache hits;
- wall time;
- cost per verified solve;
- false-done rate;
- resource-exhausted rate.

---

# 28. CI rollout

## Phase 1 - Shadow

- Harness Manifest ON;
- anchor runner ON;
- Regression Gate report-only;
- resource snapshots telemetry-only;
- budget awareness non-blocking.

## Phase 2 - Resource awareness

- latest snapshot model-visible;
- verification reserve advisory.

## Phase 3 - Protected verification reserve

- Kraken BUILD first;
- Mission/Gauntlet after smoke.

## Phase 4 - Blocking regression gate

- Tier 0 PR blocking;
- Tier 1 merge/release blocking.

## Phase 5 - Budget-aware repair/pivot

- Gauntlet first;
- then Mission;
- Kraken only with a positive benchmark.

---

# 29. Suggested PR sequence

1. `feat(runtime): add canonical harness manifest`
2. `feat(eval): add historical anchor format and runner`
3. `feat(eval): add harness regression retention gate`
4. `feat(runtime): add central resource budget and ledger`
5. `feat(session): expose durable latest resource snapshot`
6. `feat(runtime): reserve resources for deterministic verification`
7. `feat(session): add first-class task contract`
8. `feat(runtime): add budget-aware repair and pivot policy`
9. `feat(eval): add unified cost-per-verified-solve metrics`
10. `feat(eval): classify harness changes and target retention anchors`
11. `chore(ci): enforce stable retention gate`

---

# 30. Proposed milestone - Zelari 2.6

2.6 can be considered complete when:

- [ ] every session records `HarnessManifest`;
- [ ] the resource policy is included in the manifest;
- [ ] 15-25 stable anchors exist;
- [ ] Tier 0 runs in CI;
- [ ] the Regression Gate compares candidate vs baseline;
- [ ] the retention budget is explicit;
- [ ] `ResourceBudget` is central;
- [ ] the ResourceLedger is rebuildable;
- [ ] the latest `resource.snapshot` is model-visible;
- [ ] a verification reserve exists;
- [ ] a deterministic PASS ends without spending the remaining budget;
- [ ] resource exhaustion does not produce false PASSes;
- [ ] TaskContract is first-class;
- [ ] compaction uses TaskContract when available;
- [ ] Gauntlet/Verification share criteria;
- [ ] cost per verified solve is measured;
- [ ] manifest diff identifies behavioral changes.

Not a 2.6 requirement:

- Gauntlet piece allocator;
- effort presets;
- adaptive memory;
- auto router;
- SPADE generator.

---

# 31. Success metrics

## Retention

```text
historical anchor pass rate
```

Stable target:

```text
>= baseline
```

## Acquisition

```text
new target verified solve rate
```

## Efficiency

```text
cost / verified solved task
wall time / verified solved task
tool calls / verified solved task
```

## Resource behavior

```text
verification_reserve_usage
resource_exhausted_rate
budget_pressure_distribution
repair_after_constrained_rate
pivot_success_rate
```

## Safety

```text
false_done_rate
```

must decrease or stay unchanged.

---

# 32. Guardrails against scope creep

A new feature enters only if it improves at least one of:

1. verified solve rate;
2. false-done rate;
3. retention;
4. token/cost efficiency;
5. latency;
6. recoverability;
7. measurability.

If it improves none:

```text
it does not enter
```

---

# 33. Explicit decisions

## We take

- retention gate;
- historical anchors;
- harness manifest;
- TaskContract;
- resource budget awareness;
- verification reserve;
- budget-aware repair/pivot;
- unified cost evaluation.

## We do not take

- full BATS;
- continue-after-PASS by default;
- LLM verifier as completion authority;
- a new compaction;
- auto-self-improvement in production.

---

# 34. Final architecture

```text
                           TASK
                            |
                            v
                       TaskContract
                            |
          +-----------------+-----------------+
          v                 v                 v
   HarnessManifest    ResourceBudget     SessionSpine
          |                 |                 |
          |           ResourceLedger          |
          |                 |                 |
          +-----------------+-----------------+
                            v
                     AgentHarness
                            |
                      ToolRegistry
                            |
                      real effects
                            |
                +-----------+-----------+
                v                       v
         VerificationEngine       resource state
                |                       |
                v                       v
         CompletionPolicy      repair/pivot/hold
                |
                v
         verified outcome
                |
                v
            Eval Store
                |
        +-------+-------+
        v               v
  New-target eval   Historical Anchors
        |               |
        +-------+-------+
                v
         Regression Gate
                |
         +------+------+
         v             v
      COMMIT        REJECT
```

---

# 35. Final principle

Zelari must not become a system that "uses more resources because it can".

It must become a system that knows:

```text
which goal it must satisfy
+
which evidence it still has to produce
+
how much budget it has left
+
which historical capabilities it must not lose
+
how much a verified solve really costs
```

Final rule:

> **Spending budget is justified only if it increases the probability of reaching a verified solution; changing the harness is justified only if it improves the system without forgetting what it already knew how to do.**