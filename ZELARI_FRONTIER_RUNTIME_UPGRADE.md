# ZELARI_FRONTIER_RUNTIME_UPGRADE.md

# Zelari Code - Frontier Runtime Upgrade
## Observer Bus, Steering, Runtime Guards, Kraken Activity, Context Projection, Run Recorder & Evaluation

**Target repository:** `N-THEM-Studio/zelari-code`
**Reference project studied:** `ApodexAI/FrontierAgent`
**Target area:** `@zelari/core` + CLI/headless protocol + Zelari Desktop
**Status:** Implementation specification
**Baseline:** repository `main`, August 25, 2026

---

# 0. Executive summary

This specification proposes a series of improvements to Zelari Code inspired by the most interesting architectural patterns observed in FrontierAgent, without introducing a new concurrent multi-agent mode alongside Kraken.

The guiding principle is:

> **Do not create a new Agent Team. Improve the runtime that already powers Kraken, Council and Zelari.**

Zelari already has very advanced components:

- Kraken lead + `explore`, `general`, `verify` tentacles;
- Kraken Graph DAG;
- parallelism and worktrees;
- strict verification;
- native criteria pack;
- durable state;
- checkpoints;
- semantic search;
- diagnostics;
- mission loop;
- headless NDJSON;
- Desktop Tauri.

The main gaps to close are instead:

1. a uniform **Observer / Intervention Runtime**;
2. **live steering** during a run;
3. intelligent **anti-loop / no-progress guards**;
4. a **Kraken Activity UI** that makes what lead and tentacles do visible;
5. structural separation between the complete **Run Record** and the **Context Projection** sent to the model;
6. recoverable and deduplicated tool-result spill;
7. **typed compaction state**;
8. **ContextPolicy per agent type**;
9. **Run Flight Recorder**;
10. an **A/B evaluation harness** to actually measure improvements, cost and latency.

The recommended roadmap is:

```text
PHASE 1  Observer Runtime + Runtime Guards
PHASE 2  Bidirectional Headless Control + Steering
PHASE 3  Kraken Activity / Run Inspector
PHASE 4  Context Engine v2
PHASE 5  Run Flight Recorder
PHASE 6  Zelari Eval / A-B Harness
```

---

# 1. What to take from FrontierAgent and what NOT to take

## 1.1 Useful patterns

FrontierAgent has some concepts that transfer very well to Zelari:

- observer callbacks on the loop;
- explicit interventions;
- async input during a run;
- safe turn boundary;
- live task/activity board;
- full run record separate from the actual prompt;
- spill of oversized tool outputs;
- typed compaction;
- per-agent context projection;
- run artifacts;
- A/B benchmark.

These concepts improve the reliability and observability of an agentic runtime without imposing a new orchestration architecture.

## 1.2 What not to duplicate

Do not add a fourth mode called, for example:

```text
agent-team
frontier
swarm
multi
```

Kraken already has:

```text
Kraken Lead
|-> Explore
|-> General
|-> Verify
|-> Graph DAG
```

and Council already has a separate multi-agent workflow.

A further orchestrator would increase:

- complexity;
- duplication;
- maintenance costs;
- UX ambiguity;
- test difficulty.

The correct direction is therefore:

```text
               Shared Runtime Infrastructure
                          |
        +------------------+------------------+
        |                  |                  |
      Kraken            Council           Zelari
        |                                    |
     Graph/Tentacles                     Missions
```

---

# 2. Target architecture

## 2.1 Overview

```text
+------------------------------------------------------------+
|                      Zelari Desktop                        |
|                                                            |
| Chat       Kraken Activity      Run Inspector              |
|   |               |                  |                     |
|   +---------------------------------+                     |
|                   |                                        |
|        Steer / Queue / Cancel / Retry                      |
+------------------------------------------------------------+
                    |
                    | ControlEvent
                    v
+------------------------------------------------------------+
|                  Headless Control Plane                    |
|                                                            |
| stdin  <- ControlEvent                                      |
| stdout -> BrainEvent                                        |
+------------------------------------------------------------+
                    |
                    v
+------------------------------------------------------------+
|                    Agent Runtime                           |
|                                                            |
|  Observer Bus                                              |
|  |-> SteeringObserver                                      |
|  |-> RepetitionGuard                                       |
|  |-> NoProgressGuard                                       |
|  |-> VerificationObserver                                  |
|  |-> DiagnosticsObserver                                   |
|  |-> TraceObserver                                         |
|  |-> MetricsObserver                                       |
|  |-> ContextObserver                                       |
|                                                            |
|  AgentHarness                                              |
|       |                                                    |
|       +-> Provider                                         |
|       +-> Tools                                            |
|       +-> Context Engine                                   |
+------------------------------------------------------------+
                |                               |
                v                               v
         Kraken / Council                Run Flight Recorder
                |                               |
       +--------+--------+              .zelari/runs/<id>/
       |        |        |
    Explore  General   Verify
```

---

# 3. PHASE 1 - Observer / Intervention Runtime

## 3.1 Goal

Create a common API that allows independent modules to:

- observe the agent loop;
- record telemetry;
- detect loops;
- block or modify a tool call;
- request a retry;
- inject instructions;
- stop a run;
- transform a result before it enters the context.

The core runtime must remain as neutral as possible.

---

# 4. New Observer module

## 4.1 Proposed location

If `AgentHarness` is in:

```text
packages/core/src/core/AgentHarness.ts
```

create:

```text
packages/core/src/runtime/observers/
|-> types.ts
|-> ObserverBus.ts
|-> composeObservers.ts
|-> RuntimeGuardObserver.ts
|-> SteeringObserver.ts
|-> TraceObserver.ts
|-> MetricsObserver.ts
|-> index.ts
```

If the repository uses a different convention, keep the same logical separation.

---

# 5. Event model

## 5.1 Runtime metadata

```ts
export type AgentRole =
  | "lead"
  | "explore"
  | "general"
  | "verify"
  | "planner"
  | "council"
  | "mission";

export interface RuntimeIdentity {
  runId: string;
  agentId: string;
  parentAgentId?: string;
  role: AgentRole;
  mode: "kraken" | "council" | "zelari";
  model?: string;
  provider?: string;
  graphNodeId?: string;
}
```

---

## 5.2 Observer event base

```ts
export interface RuntimeEventBase {
  id: string;
  ts: number;
  identity: RuntimeIdentity;
  turn: number;
}
```

---

## 5.3 Main callbacks

```ts
export interface AgentObserver {
  onRunStart?(event: RunStartEvent): ObserverResult | Promise<ObserverResult>;

  onModelAttempt?(
    event: ModelAttemptEvent
  ): ObserverResult | Promise<ObserverResult>;

  onModelDelta?(
    event: ModelDeltaEvent
  ): ObserverResult | Promise<ObserverResult>;

  onModelResponse?(
    event: ModelResponseEvent
  ): ObserverResult | Promise<ObserverResult>;

  onToolCall?(
    event: ToolCallEvent
  ): ObserverResult | Promise<ObserverResult>;

  onToolResult?(
    event: ToolResultEvent
  ): ObserverResult | Promise<ObserverResult>;

  onTurnEnd?(
    event: TurnEndEvent
  ): ObserverResult | Promise<ObserverResult>;

  onRunEnd?(
    event: RunEndEvent
  ): ObserverResult | Promise<ObserverResult>;

  onCancelled?(
    event: RunCancelledEvent
  ): ObserverResult | Promise<ObserverResult>;
}
```

---

# 6. Intervention contract

## 6.1 Base type

```ts
export type ObserverResult =
  | { action: "continue" }
  | { action: "retry"; reason?: string; consumeTurn?: boolean }
  | { action: "stop"; reason: string; code?: string }
  | { action: "replace"; content: unknown }
  | { action: "inject"; message: RuntimeInjectedMessage }
  | { action: "deny_tool"; reason: string };
```

Default:

```ts
const CONTINUE: ObserverResult = { action: "continue" };
```

---

## 6.2 Rules

An observer:

- must not silently mutate global state;
- must return an explicit result;
- must not throw exceptions for a normal policy decision;
- can be `best-effort` or `fail-closed`.

---

# 7. Observer policy

## 7.1 Classification

```ts
export type ObserverFailureMode =
  | "ignore"
  | "warn"
  | "fail-closed";
```

Examples:

```text
MetricsObserver          -> ignore
TraceObserver            -> warn
RepetitionGuard          -> warn
AuthorizationObserver    -> fail-closed
```

---

## 7.2 Descriptor

```ts
export interface ObserverDescriptor {
  id: string;
  priority: number;
  failureMode: ObserverFailureMode;
  observer: AgentObserver;
}
```

---

# 8. ObserverBus

```ts
export class ObserverBus {
  constructor(
    private readonly descriptors: ObserverDescriptor[]
  ) {}

  async emit<K extends keyof AgentObserver>(
    hook: K,
    event: Parameters<NonNullable<AgentObserver[K]>>[0],
  ): Promise<ObserverResult[]> {
    // stable ordering by priority
    // error handling per failureMode
    // intervention collection
  }
}
```

---

## 8.1 Recommended priorities

```text
10  authorization / safety
20  steering
30  runtime guards
40  verification
50  context
80  trace
90  metrics
```

---

# 9. Intervention resolution

Multiple observers can respond to the same event.

Semantic priority:

```text
deny_tool
stop
retry
replace
inject
continue
```

Example:

```ts
function resolveInterventions(
  results: ObserverResult[]
): ObserverResult
```

If two observers return `stop`, use the one with the higher priority and record both in the trace.

---

# 10. Integration into AgentHarness

In the existing loop:

```text
model
-> response
-> tool calls
-> tool execution
-> result
-> next turn
```

insert:

```text
onRunStart

onModelAttempt
  |
provider
  |
onModelDelta*
  |
onModelResponse

for each tool:
  onToolCall
      |
  execute
      |
  onToolResult

onTurnEnd

...

onRunEnd
```

---

# 11. Backward compatibility

The first patch must work with:

```ts
observers: []
```

without changing the current output.

The new runtime must be opt-in internally until stabilization.

Proposed feature flag:

```text
ZELARI_RUNTIME_OBSERVERS=1
```

During initial rollout:

```text
default = 0
```

After testing:

```text
default = 1
```

---

# 12. PHASE 1B - Runtime Guards

Guards must be observers, not scattered conditions in the loop.

Create:

```text
packages/core/src/runtime/guards/
|-> RepetitionGuard.ts
|-> NoProgressGuard.ts
|-> FailureSignatureGuard.ts
|-> DuplicateSearchGuard.ts
|-> ToolLoopGuard.ts
|-> ReasoningWatchdog.ts
|-> types.ts
```

---

# 13. RepetitionGuard

## 13.1 Goal

Detect semantically identical tool calls repeated without new progress.

Fingerprint:

```ts
interface ToolFingerprint {
  tool: string;
  argsHash: string;
}
```

Hash:

```ts
sha256(
  canonicalJson({
    tool,
    args: normalizedArgs
  })
)
```

---

## 13.2 Thresholds

```ts
interface RepetitionGuardConfig {
  warnAfter: number; // default 2
  stopAfter: number; // default 5
}
```

---

## 13.3 Reaction

On the second/third repetition:

```text
WARN
```

Inject:

```text
The same tool call has produced no new progress multiple times.
Reassess the current hypothesis before repeating it again.
```

At the hard limit:

```text
STOP / recovery
```

---

# 14. FailureSignatureGuard

## 14.1 Problem

The agent can edit files multiple times but still get:

```text
npm test
FAIL
```

with the same error.

You need to detect the failure signature, not just the command.

---

## 14.2 Fingerprint

For shell/test:

```ts
interface FailureSignature {
  commandHash: string;
  exitCode?: number;
  normalizedTailHash: string;
}
```

Normalize:

- timestamps;
- temp paths;
- PIDs;
- UUIDs;
- progress lines.

---

## 14.3 Example

```text
npm test
FAIL auth.spec.ts
Expected 200, received 401
```

repeated 3 times:

```text
FailureSignatureGuard
-> inject
```

message:

```text
The same failure signature has persisted across multiple attempts.
Do not repeat the previous edit strategy. Re-evaluate the root cause,
inspect upstream state, or delegate a fresh verification/exploration task.
```

---

# 15. NoProgressGuard

## 15.1 Signals

A run is potentially stalled if for N turns:

- no file changes;
- no task moves to completed;
- no new discovery;
- same error;
- same tool family;
- no new completed graph node.

---

## 15.2 Progress vector

```ts
export interface ProgressVector {
  filesChanged: number;
  uniqueTools: number;
  completedGraphNodes: number;
  completedTasks: number;
  newDiscoveries: number;
  verificationDelta: number;
}
```

---

## 15.3 Thresholds

```text
soft stall: 2 turns
hard stall: 5 turns
```

For Zelari missions `ZELARI_MISSION_MAX_STALL` already exists.

The new guard must generalize the concept to the normal Kraken runtime.

---

# 16. DuplicateSearchGuard

Detect:

```text
grep A
grep A
grep A
```

or semantically near-identical queries.

For:

```text
grep_content
semantic_search
web_search
list_files
```

apply dedicated fingerprints.

---

# 17. Reasoning / Provider watchdog

Zelari already has:

```text
ZELARI_PROVIDER_TIMEOUT_MS
```

Add separate telemetry and warning:

```text
model_call_started
model_first_token
model_call_finished
```

Metrics:

```text
time_to_first_token
generation_duration
stream_idle_duration
```

Proposed feature env:

```text
ZELARI_MODEL_FIRST_TOKEN_WARN_MS
ZELARI_MODEL_STREAM_IDLE_MS
```

Do not automatically interrupt providers that support long reasoning without evidence of a real block.

---

# 18. Runtime Guard settings in Desktop

In:

```text
Settings -> Defaults -> Runtime Guards
```

add:

```text
Runtime guardrails           ON

Repeated tool guard          ON
No-progress guard            ON
Repeated failure guard       ON
```

In the first version use presets and do not expose all the thresholds.

---

# 19. Runtime Guards tooltips

## Runtime guardrails

```text
Detects repeated actions, persistent failures and runs that stop making
progress. Zelari can warn the agent, request a new strategy or stop a
pathological loop before it wastes more time and tokens.
```

## Repeated tool guard

```text
Detects equivalent tool calls repeated without useful new results and asks
the agent to reassess its strategy.
```

## No-progress guard

```text
Tracks whether the run is producing meaningful progress such as completed
tasks, new evidence, file changes or improved verification results.
```

## Repeated failure guard

```text
Detects the same test, build or command failure recurring after multiple
attempts and forces a root-cause reassessment instead of blind retries.
```

---

# 20. PHASE 2 - Live Steering

## 20.1 Goal

Allow the user to send a message while Kraken is working.

Example:

```text
Do not modify the database.
Keep the existing schema.
```

The message:

- does not cancel the current tool;
- does not interrupt an in-progress provider call;
- enters at the next safe boundary;
- is delivered to the Kraken Lead;
- is not retroactively sent to tentacles already running;
- influences new delegations and the next synthesis.

---

# 21. Safe boundary semantics

A `steer` can be applied:

```text
V after a tool result
V before the next model call
V after tentacle fan-in
V between mission nodes
```

Do not apply it:

```text
X during a write_file
X in the middle of apply_diff
X in the middle of a streaming response
X between tool_call and tool_result
```

---

# 22. Headless control plane

The Desktop today uses:

```text
zelari-code --headless
stdout -> NDJSON BrainEvent
```

For live steering the protocol must become bidirectional:

```text
stdin  <- NDJSON ControlEvent
stdout -> NDJSON BrainEvent
```

---

# 23. New ControlEvent

```ts
export type ControlEvent =
  | SteerControlEvent
  | FollowUpControlEvent
  | CancelControlEvent
  | PauseControlEvent
  | ResumeControlEvent;
```

---

## 23.1 Steer

```ts
export interface SteerControlEvent {
  type: "steer";
  id: string;
  text: string;
  ts: number;
  target?: "lead";
}
```

---

## 23.2 Follow-up

```ts
export interface FollowUpControlEvent {
  type: "follow_up";
  id: string;
  text: string;
  ts: number;
}
```

Semantics:

```text
current run finishes
-> follow-up becomes the next user task
```

---

## 23.3 Cancel

```ts
export interface CancelControlEvent {
  type: "cancel";
  id: string;
  reason?: string;
  ts: number;
}
```

---

# 24. Control acknowledgements

Add BrainEvent:

```ts
export interface ControlAcceptedEvent {
  type: "control_accepted";
  controlId: string;
  controlType: string;
}
```

```ts
export interface ControlAppliedEvent {
  type: "control_applied";
  controlId: string;
  controlType: string;
  boundary: string;
}
```

```ts
export interface ControlRejectedEvent {
  type: "control_rejected";
  controlId: string;
  reason: string;
}
```

The Desktop must not show "steered" just because it wrote to stdin.

It must wait for `control_accepted`.

---

# 25. Internal queue

```ts
export class RuntimeControlQueue {
  enqueue(event: ControlEvent): void;
  peek(): ControlEvent | undefined;
  drainSteers(): SteerControlEvent[];
  drainFollowUps(): FollowUpControlEvent[];
}
```

FIFO.

---

# 26. SteeringObserver

```ts
export class SteeringObserver implements AgentObserver {
  constructor(
    private readonly queue: RuntimeControlQueue
  ) {}

  async onTurnEnd(event: TurnEndEvent): Promise<ObserverResult> {
    const steers = this.queue.drainSteers();

    if (!steers.length) {
      return { action: "continue" };
    }

    return {
      action: "inject",
      message: {
        role: "user",
        kind: "runtime-steer",
        content: renderSteers(steers),
      },
    };
  }
}
```

---

# 27. Multiple steer semantics

If these arrive:

```text
1. Do not touch the database
2. Actually: you can add a migration, but do not drop columns
```

do not compact automatically.

Inject in order:

```text
Runtime user steering received during execution:

[1]
Do not touch the database

[2]
Actually: you can add a migration, but do not drop columns

Later instructions may supersede earlier ones.
```

---

# 28. Late steer

If the run has already reached the last useful boundary:

```text
steer
-> preserved
-> converted to follow-up
```

The Desktop must show:

```text
Queued as follow-up
```

---

# 29. Steering with Kraken Graph

Rule:

```text
Steer -> Lead / Graph coordinator
```

Do not directly interrupt:

```text
General #2 already in worktree
Explore #3 already running
```

The Lead can:

- not launch future nodes;
- change verifications;
- add a fix node;
- discard incompatible results;
- modify the synthesis.

Optional future feature:

```text
targetAgentId
```

Do not implement it in the first version.

---

# 30. Desktop composer during a run

Mockup:

```text
+----------------------------------------------------+
| Do not modify the public API...                    |
|                                                    |
| [Steer current run] [Queue follow-up]      [Stop]  |
+----------------------------------------------------+
```

Default when a run is active:

```text
Enter -> Steer current run
Shift+Enter -> newline
```

Or keep `Send` and show a menu:

```text
Send as:
> Steer current run
  Queue follow-up
```

---

# 31. Steering tooltips

## Steer current run

```text
Sends a new instruction to the running Kraken task. The instruction is
applied at the next safe turn boundary and does not interrupt an active
model request or tool call.
```

## Queue follow-up

```text
Adds this message after the current run. It will start only when the active
task has finished or stopped.
```

## Stop

```text
Requests cooperative cancellation of the current run. In-flight tools are
allowed to finish or terminate according to their cancellation policy.
```

---

# 32. Desktop queue display

In the composer/status:

```text
Queued: 2
```

Click:

```text
Pending controls

STEER
1. Do not change public API

FOLLOW-UP
2. Add regression tests
```

Allow:

```text
Remove
```

until it is `control_applied`.

---

# 33. Tauri bridge

The Rust bridge today manages the headless process.

For steering:

- keep the child's stdin handle;
- keep the child id per run;
- allow an additional Tauri command.

Proposal:

```rust
#[tauri::command]
async fn send_control(
    state: State<'_, RunManager>,
    run_id: String,
    event: ControlEvent,
) -> Result<(), String>
```

---

# 34. RunManager on the Rust side

```rust
struct ActiveRun {
    child: Child,
    stdin: ChildStdin,
    started_at: Instant,
}

struct RunManager {
    active: Mutex<HashMap<String, ActiveRun>>,
}
```

Methods:

```text
start
send_control
cancel
cleanup
```

---

# 35. Protocol version

Add handshake/event:

```json
{
  "type": "protocol_info",
  "version": 2,
  "capabilities": [
    "stdin-control",
    "steer",
    "follow-up",
    "cancel"
  ]
}
```

The Desktop must fall back if it uses an old CLI:

```text
protocol v1
-> disables Steer
-> shows tooltip:
  "Update Zelari CLI to use live steering."
```

---

# 36. PHASE 3 - Kraken Activity

## 36.1 Goal

Make visible:

- Kraken lead;
- tentacles;
- Graph nodes;
- model;
- status;
- duration;
- scope;
- worktree;
- current tools;
- errors;
- verification.

Not a replacement for the chat.

---

# 37. New activity BrainEvents

## Agent spawned

```ts
interface AgentSpawnedEvent {
  type: "agent_spawned";

  runId: string;
  agentId: string;
  parentAgentId?: string;

  role:
    | "lead"
    | "explore"
    | "general"
    | "verify"
    | "planner";

  model?: string;
  provider?: string;

  title?: string;
  scope?: string[];

  graphNodeId?: string;
  worktree?: string;

  ts: number;
}
```

---

## Agent status

```ts
interface AgentStatusEvent {
  type: "agent_status";
  agentId: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled";
  message?: string;
  ts: number;
}
```

---

## Agent tool event

```ts
interface AgentToolEvent {
  type: "agent_tool";
  agentId: string;
  toolCallId: string;
  tool: string;
  status: "started" | "completed" | "failed";
  summary?: string;
  durationMs?: number;
}
```

---

## Agent end

```ts
interface AgentEndedEvent {
  type: "agent_ended";
  agentId: string;
  reason: string;
  durationMs: number;
  tokenUsage?: {
    input?: number;
    output?: number;
  };
}
```

---

# 38. Desktop activity store

Create:

```text
apps/desktop/src/activity/
|-> types.ts
|-> activityReducer.ts
|-> activitySelectors.ts
|-> useRunActivity.ts
```

State:

```ts
interface RunActivityState {
  runId?: string;
  agents: Record<string, ActivityAgent>;
  graph?: ActivityGraph;
  controls: RuntimeControlState[];
}
```

---

# 39. ActivityAgent

```ts
interface ActivityAgent {
  id: string;
  parentId?: string;

  role: AgentRole;
  title?: string;

  model?: string;
  provider?: string;

  status: AgentStatus;

  startedAt?: number;
  endedAt?: number;

  scope?: string[];
  worktree?: string;
  graphNodeId?: string;

  currentTool?: string;

  tools: ActivityTool[];
  warnings: ActivityWarning[];
}
```

---

# 40. Proposed UI

New panel:

```text
KRAKEN ACTIVITY

LEAD
@ Kraken
  model: strong-coding-model
  02:31

TENTACLES

@ Explore #1                     V 0:18
   auth architecture
   model: fast-model

@ General #2                     ~ 1:12
   src/auth/**
   model: coding-model
   worktree: kraken-82a1

@ Verify #3                      - queued
   waiting for General #2
   model: review-model

GRAPH
3 / 6 complete
```

---

# 41. Agent symbols

Proposal:

```text
Lead      *
Explore   ?
General   ~
Verify    V
Planner   +
Fix       !
```

Avoid using color as the only indicator.

---

# 42. Expanded agent details

Click on `General #2`:

```text
General #2

Status       Running
Model        coding-model
Provider     OpenAI-compatible
Duration     01:12
Scope        src/auth/**
Worktree     .zelari/worktrees/kraken-82a1
Graph node   auth-implementation

Recent activity

V read_file     src/auth/session.ts
V grep_content  refreshToken
V edit_file     src/auth/session.ts
@ bash          npm test -- auth
```

---

# 43. Tool details

Click on a tool:

```text
Tool
bash

Command
npm test -- auth

Started
12:31:07

Duration
8.2 s

Exit code
1

Output preview
...

Full result
[Open from run record]
```

The panel must not automatically load enormous outputs.

---

# 44. Kraken Graph UI

If Graph is active:

```text
Graph

V inspect-auth
|-- V api-change
|-- ? frontend-change
|-- ? verify
```

Show dependencies without requiring a complex graph library in the first version.

First version:

```text
indented dependency list
```

Future phase:

```text
visual DAG
```

---

# 45. Activity tooltips

## Kraken Activity

```text
Shows the live execution state of the Kraken lead, tentacles and Graph nodes,
including model routing, current tools, duration, scope and verification state.
```

## Tentacle model

```text
The model currently assigned to this Kraken role. It can differ from the
lead model when Kraken Model Routing is configured.
```

## Worktree

```text
An isolated Git worktree used by a writing tentacle so parallel agents do not
edit the same working tree directly.
```

---

# 46. PHASE 4 - Context Engine v2

## 46.1 Principle

The complete historical record and the context sent to the provider must be different objects.

```text
RunRecord
    |
    v
ContextProjector
    |
    v
ProjectedContext
    |
    v
Provider
```

Never:

```text
truncate/mutate original transcript
```

---

# 47. New modules

```text
packages/core/src/context/
|-> RunRecord.ts
|-> RunRecordStore.ts
|-> ContextProjector.ts
|-> ContextPolicy.ts
|-> ToolResultSpill.ts
|-> CompactionState.ts
|-> renderCompaction.ts
|-> tokenBudget.ts
|-> index.ts
```

---

# 48. RunRecord

```ts
export interface RunRecord {
  runId: string;
  events: RunRecordEvent[];
}
```

Events:

```ts
export type RunRecordEvent =
  | UserMessageRecord
  | AssistantMessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | SteeringRecord
  | CompactionRecord
  | VerificationRecord
  | AgentLifecycleRecord;
```

---

# 49. Integrity rule

The RunRecord must preserve:

- complete content;
- complete tool output or a lossless pointer;
- order;
- parent/child agent;
- run id;
- turn id;
- tool call id;
- model;
- timestamps.

The projection can be lossy.

The record must not be.

---

# 50. ContextPolicy

```ts
export interface AgentContextPolicy {
  history:
    | "full"
    | "recent"
    | "summary"
    | "none";

  includeParentSummary: boolean;
  includeDurableState: boolean;
  includeGraphState: boolean;
  includeVerificationState: boolean;

  toolResults:
    | "full"
    | "projected"
    | "summary-only";

  maxPromptTokens?: number;
  maxToolResultChars?: number;
  maxHistoryTurns?: number;
}
```

---

# 51. Policy per Kraken role

## Lead

```ts
const KRAKEN_LEAD_POLICY: AgentContextPolicy = {
  history: "recent",
  includeParentSummary: false,
  includeDurableState: true,
  includeGraphState: true,
  includeVerificationState: true,
  toolResults: "projected",
};
```

---

## Explore

```ts
const KRAKEN_EXPLORE_POLICY: AgentContextPolicy = {
  history: "summary",
  includeParentSummary: true,
  includeDurableState: true,
  includeGraphState: false,
  includeVerificationState: false,
  toolResults: "projected",
};
```

Explore should not receive full transcripts of other tentacles.

---

## General

```ts
const KRAKEN_GENERAL_POLICY: AgentContextPolicy = {
  history: "summary",
  includeParentSummary: true,
  includeDurableState: true,
  includeGraphState: true,
  includeVerificationState: false,
  toolResults: "projected",
};
```

---

## Verify

```ts
const KRAKEN_VERIFY_POLICY: AgentContextPolicy = {
  history: "summary",
  includeParentSummary: true,
  includeDurableState: false,
  includeGraphState: true,
  includeVerificationState: true,
  toolResults: "projected",
};
```

Verify should mainly receive:

- goal;
- diff;
- change summary;
- test command;
- implementation report;
- failure evidence.

---

# 52. ContextProjector

```ts
export class ContextProjector {
  project(
    record: RunRecord,
    policy: AgentContextPolicy,
    budget: TokenBudget
  ): ProjectedContext {
    // 1. system identity
    // 2. stable prefix
    // 3. durable context
    // 4. compact state
    // 5. selected recent history
    // 6. tool previews
    // 7. current user instruction
  }
}
```

---

# 53. ProjectedContext

```ts
export interface ProjectedContext {
  messages: ProviderMessage[];
  stats: {
    estimatedTokens: number;
    omittedEvents: number;
    spilledResults: number;
    compactionId?: string;
  };
}
```

---

# 54. Tool-result spill

## 54.1 Goal

When a tool produces enormous output:

```text
full result
-> spill store
-> short preview + recovery pointer
```

---

# 55. Spill directory

Proposal:

```text
.zelari/runs/<run-id>/spill/
```

But the model should not be able to modify it.

If the Zelari sandbox allows access policies:

```text
READ  V
WRITE X
```

If that is not technically possible in all modes, at least:

- do not include the directory in write roots;
- block `write_file/edit_file` toward spill;
- block shell redirects if an authorization layer already exists.

---

# 56. Content-addressed spill

Name:

```ts
sha256(toolName + "\0" + fullBody).slice(0, 16)
```

Path:

```text
spill/bash-4a81f9a2c19f0b33.txt
```

If it already exists:

```text
skip write
```

---

# 57. ToolResultRef

```ts
export interface ToolResultRef {
  kind: "tool-result-ref";
  toolCallId: string;
  toolName: string;

  path: string;

  sha256: string;
  chars: number;
  bytes: number;

  preview: string;
  truncated: boolean;
}
```

---

# 58. Recovery pointer

The message to the model:

```text
[Tool output truncated]

Preview:
...

Full output:
.zelari/runs/<run-id>/spill/bash-4a81f9a2c19f0b33.txt

Use read_file only if the omitted content is necessary.
```

The pointer must be counted in the total cap.

---

# 59. Aggregate tool-result budget

Do not limit only each individual result.

A per-turn budget is needed.

Example:

```text
max single tool result inline: 12k chars
max all tool results in turn: 32k chars
```

If 6 parallel tools each produce 10k:

```text
60k total
-> spill / reduce
```

---

# 60. Proposed config

```text
ZELARI_TOOL_RESULT_INLINE_CHARS=12000
ZELARI_TOOL_RESULT_TURN_CHARS=32000
ZELARI_TOOL_RESULT_SPILL=1
```

Do not expose them in the normal Desktop right away.

Eventually put them under:

```text
Advanced
```

---

# 61. Truncation strategy

Do not prematurely optimize `head` vs `head+tail`.

Recommended initial implementation:

```text
ranked results
-> head

sequential logs
-> head + tail
```

but behind a configurable policy.

Important:

- full spill always recoverable;
- aggregate budget;
- pointer in the cap;
- content hash;
- recovery read metrics.

---

# 62. Typed CompactionState

Do not save only a prose summary.

```ts
export interface CompactionState {
  version: 1;

  id: string;
  createdAt: number;

  goal: string;

  completed: CompactedTask[];
  pending: CompactedTask[];

  decisions: CompactedDecision[];
  discoveries: CompactedDiscovery[];

  filesTouched: string[];

  failures: CompactedFailure[];

  verification: {
    status: "pass" | "fail" | "unknown";
    notes: string[];
  };

  recoveryHandles: RecoveryHandle[];

  sourceEventRange: {
    from: number;
    to: number;
  };
}
```

---

# 63. RecoveryHandle

```ts
export type RecoveryHandle =
  | {
      kind: "tool-result";
      path: string;
      summary: string;
    }
  | {
      kind: "run-record";
      eventId: string;
      summary: string;
    }
  | {
      kind: "file";
      path: string;
      summary: string;
    };
```

---

# 64. Render compaction

```ts
function renderCompactionForModel(
  state: CompactionState
): string
```

The model sees markdown.

The runtime keeps the typed JSON.

---

# 65. Compaction storage

```text
.zelari/runs/<run-id>/compactions/
|-> c001.json
|-> c002.json
|-> latest.json
```

---

# 66. Durable state vs Run compaction

Do not merge:

```text
.zelari/state/
```

with:

```text
.zelari/runs/<run>/compactions/
```

Semantics:

```text
durable state
-> verified cross-run knowledge

compaction
-> compression of the current run
```

---

# 67. PHASE 5 - Run Flight Recorder

## 67.1 Goal

Every run must be inspectable and reproducible enough to:

- debug;
- compare models;
- understand costs;
- understand loops;
- understand routing;
- visualize tentacles;
- build benchmarks.

---

# 68. Layout

```text
.zelari/
|-> runs/
    |-> <run-id>/
        |-> manifest.json
        |-> events.jsonl
        |-> trace.jsonl
        |-> metrics.json
        |-> verification.json
        |-> graph.json
        |-> controls.jsonl
        |
        |-> agents/
        |   |-> lead.jsonl
        |   |-> explore-1.jsonl
        |   |-> general-2.jsonl
        |   |-> verify-3.jsonl
        |
        |-> compactions/
        |   |-> ...
        |
        |-> spill/
            |-> ...
```

---

# 69. manifest.json

```json
{
  "version": 1,
  "runId": "run_...",
  "sessionId": "session_...",
  "mode": "kraken",
  "phase": "build",
  "startedAt": 0,
  "endedAt": 0,
  "status": "completed",
  "cwd": "...",
  "models": {
    "lead": "...",
    "explore": "...",
    "general": "...",
    "verify": "...",
    "planner": "..."
  }
}
```

Do not save:

- API keys;
- OAuth tokens;
- SSH passwords;
- secrets.

---

# 70. trace.jsonl

Complete events:

```text
run_start
agent_spawned
model_attempt
tool_call
tool_result
runtime_warning
control_received
control_applied
compaction
verification
agent_end
run_end
```

---

# 71. metrics.json

```ts
interface RunMetrics {
  durationMs: number;

  modelCalls: number;
  toolCalls: number;

  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;

  tentacles: {
    explore: number;
    general: number;
    verify: number;
  };

  retries: number;

  guards: {
    repetitionWarnings: number;
    noProgressWarnings: number;
    failureSignatureWarnings: number;
    hardStops: number;
  };

  context: {
    compactions: number;
    spillFiles: number;
    spillChars: number;
    recoveryReads: number;
    peakPromptTokens?: number;
  };
}
```

---

# 72. Desktop Run Inspector

Add:

```text
Run details
```

Sections:

```text
Overview
Agents
Tools
Context
Verification
Controls
Metrics
Files
```

---

# 73. Overview

```text
Run ID          run_8fa...
Mode            Kraken
Phase           Build
Status          Completed
Duration        02:48

Lead model      model-A
Explore model   model-B
General model   model-A
Verify model    model-C

Tentacles       4
Tool calls      31
Retries         2
Compactions     1
Warnings        1
```

---

# 74. Context tab

```text
Context

Peak prompt       72k tokens
Compactions       2
Spilled results   8
Spilled chars     420k
Recovery reads    2

Current compaction
[c002]

[View JSON]
```

---

# 75. Runtime warnings UI

Example:

```text
! Repeated failure detected
npm test returned the same auth failure 3 times.
Kraken was instructed to reassess its hypothesis.
```

---

# 76. Run Inspector tooltips

## Recovery read

```text
A tool result was too large to keep fully in the model context and was stored
in the run spill store. A recovery read occurs when the agent later opens
that full result.
```

## Compaction

```text
A structured snapshot used to reduce prompt size while preserving the task
goal, decisions, open work, failures and recovery handles.
```

---

# 77. Retention policy

Do not let `.zelari/runs` grow without limits.

Config:

```text
ZELARI_RUN_RECORD=1
ZELARI_RUN_RETENTION_DAYS=30
ZELARI_RUN_RETENTION_MAX_MB=2048
```

Cleanup:

```text
oldest completed runs first
```

Never delete:

```text
active run
```

---

# 78. Gitignore

Make sure that:

```text
.zelari/runs/
```

is gitignored by default.

---

# 79. PHASE 6 - Zelari Eval

## 79.1 Goal

Have a reproducible harness to answer questions like:

```text
Does model routing save cost without worsening pass-rate?

Does RepetitionGuard reduce tool loops?

Does spill reduce peak prompt?

Does Verify with a small model hold up?

Does a faster Graph planner worsen DAG quality?
```

---

# 80. Structure

```text
packages/eval/
or
tools/eval/
```

Proposal:

```text
tools/eval/
|-> runner.ts
|-> suites/
|-> scorers/
|-> reporters/
|-> experiments/
```

---

# 81. EvalCase

```ts
interface EvalCase {
  id: string;
  prompt: string;
  cwdFixture: string;

  expected?: {
    files?: string[];
    command?: string;
  };

  timeoutMs?: number;
}
```

---

# 82. EvalArm

```ts
interface EvalArm {
  id: string;
  env: Record<string, string>;
  provider?: string;
  model?: string;
}
```

---

# 83. Model routing experiment

```ts
const arms: EvalArm[] = [
  {
    id: "all-lead",
    env: {
      ZELARI_KRAKEN_EXPLORE_MODEL: "",
      ZELARI_KRAKEN_GENERAL_MODEL: "",
      ZELARI_KRAKEN_VERIFY_MODEL: "",
    },
  },
  {
    id: "routed",
    env: {
      ZELARI_KRAKEN_EXPLORE_MODEL: "fast-model",
      ZELARI_KRAKEN_GENERAL_MODEL: "strong-model",
      ZELARI_KRAKEN_VERIFY_MODEL: "review-model",
    },
  },
];
```

---

# 84. Minimum metrics

```text
pass rate
duration
input tokens
output tokens
cached tokens
estimated/provider cost
tool calls
tentacles
retries
verification failures
runtime guard warnings
compactions
peak prompt
spill count
recovery reads
```

---

# 85. Tabular result

```text
Metric               all-lead     routed

Pass rate               82%         83%
Duration mean            94s         66s
Input tokens             81k         53k
Output tokens            18k         17k
Tool calls               31          29
Retry count              1.8         1.5
Verification fail         7%          6%
```

---

# 86. Reproducibility

Every result must save:

```text
git commit
CLI version
provider
model ids
env diff
seed if applicable
fixture hash
timestamp
```

---

# 87. Guard A/B

Experiment:

```text
A = runtime guards OFF
B = runtime guards ON
```

Measure:

```text
tool calls
stalled runs
same failure repetitions
duration
pass rate
```

---

# 88. Context A/B

Experiment:

```text
A = current context behavior
B = Context Engine v2
```

Measure:

```text
peak prompt tokens
compactions
recovery reads
duration
score/pass
```

---

# 89. New BrainEvents - consolidated list

Add progressively:

```text
protocol_info

control_accepted
control_applied
control_rejected

agent_spawned
agent_status
agent_tool
agent_ended

runtime_warning
runtime_intervention

context_projected
tool_result_spilled
compaction_created

run_metrics
```

---

# 90. runtime_warning

```ts
interface RuntimeWarningEvent {
  type: "runtime_warning";

  code:
    | "repeated_tool"
    | "repeated_failure"
    | "no_progress"
    | "provider_idle"
    | "context_pressure";

  message: string;

  agentId?: string;

  count?: number;
  ts: number;
}
```

---

# 91. runtime_intervention

```ts
interface RuntimeInterventionEvent {
  type: "runtime_intervention";

  source: string;

  action:
    | "retry"
    | "stop"
    | "inject"
    | "deny_tool"
    | "replace";

  reason?: string;

  agentId?: string;
}
```

---

# 92. context_projected

```ts
interface ContextProjectedEvent {
  type: "context_projected";

  agentId: string;

  estimatedTokens?: number;

  includedEvents: number;
  omittedEvents: number;

  spilledResults: number;

  compactionId?: string;
}
```

---

# 93. tool_result_spilled

```ts
interface ToolResultSpilledEvent {
  type: "tool_result_spilled";

  agentId: string;
  toolCallId: string;

  path: string;

  chars: number;
  previewChars: number;

  sha256: string;
}
```

---

# 94. Proposed Desktop settings

## Settings -> Defaults

```text
Runtime Guards
  Runtime guardrails        ON
  Repeated tool guard       ON
  No-progress guard         ON
  Repeated failure guard    ON
```

## Settings -> Advanced

```text
Runtime

  Live steering             ON
  Run flight recorder       ON

Context

  Context Engine v2         ON
  Tool-result spill         ON
```

During rollout, some options can be marked:

```text
Experimental
```

---

# 95. Live steering tooltip

```text
Allows new instructions to be sent while an agent is working. They are
queued and applied at a safe turn boundary without interrupting an active
tool call or model request.
```

---

# 96. Run flight recorder tooltip

```text
Stores structured events, metrics, agent activity, verification data and
context diagnostics for each run under .zelari/runs. Secrets are never
written to the recorder.
```

---

# 97. Context Engine v2 tooltip

```text
Separates the complete run record from the smaller context sent to the model.
This allows long tasks to retain recoverable evidence without keeping every
tool result in every model request.
```

---

# 98. Tool-result spill tooltip

```text
Stores oversized tool outputs outside the active prompt and gives the agent
a short preview plus a recovery path. The complete output remains available
when it is actually needed.
```

---

# 99. Security considerations

## 99.1 Secrets

The recorder must redact:

```text
Authorization headers
API keys
OAuth tokens
SSH passwords
secret env vars
```

Create a centralized function:

```ts
redactRuntimePayload()
```

Do not rely on individual writers.

---

# 100. Tool result safety

Spill can contain secrets printed by a shell.

Therefore:

- local directory not world-readable when possible;
- do not sync;
- do not automatically include in reports;
- configurable retention.

---

# 101. Control injection safety

`steer` is a new user message and must be treated as user input.

It must not:

- bypass Plan mode;
- bypass folder trust;
- bypass tool permissions;
- bypass the Strict gate.

---

# 102. Observer safety

Authorization observer:

```text
fail-closed
```

Metrics observer:

```text
best-effort
```

A recorder failure must not normally block the run.

An authorization layer failure must.

---

# 103. Cancellation semantics

Cancellation must be cooperative.

Order:

```text
1. mark cancellation requested
2. stop scheduling new tools/tentacles
3. abort provider request if AbortController is supported
4. cancel pending graph nodes
5. allow cleanup hooks
6. emit run_cancelled
7. persist run state
```

---

# 104. Kraken tentacle cancellation

For a tentacle:

```text
running shell
-> AbortSignal if supported
-> grace period
-> existing Kraken cancel grace logic
```

Reuse:

```text
ZELARI_KRAKEN_CANCEL_GRACE_MS
```

do not create a second equivalent timeout.

---

# 105. Integration with the Strict Gate

Runtime Guards must not declare `done`.

Pipeline:

```text
Agent output
    |
Runtime Guards
    |
Verification
    |
Strict Gate
    |
Completed
```

An observer can prevent pathological continuation, but not replace verification.

---

# 106. Integration with the Native Criteria Pack

The `Native Criteria Pack` must emit events:

```text
verification_check_started
verification_check_completed
```

and these must end up in the Run Recorder.

---

# 107. Integration with the Advisory verifier

The advisory verifier remains:

```text
optional LLM judge
```

Do not use the advisory verifier as a RepetitionGuard.

They are different responsibilities.

---

# 108. Integration with Kraken Model Routing

The new Activity UI must show:

```text
actual resolved model
```

not simply the Settings preference.

Example:

```text
Explore configured: Inherit
Resolved runtime model: fast-model
```

The `agent_spawned` event must contain the actually resolved model.

---

# 109. Integration with Kraken Graph

The planner must emit:

```text
agent_spawned role=planner
```

Graph state must be recorded:

```text
graph.json
```

and updated atomically.

---

# 110. Integration with `.zelari/radio`

Do not remove radio in the first implementation.

Possible roles:

```text
radio
-> tentacle communication

Observer Bus
-> lifecycle/intervention/runtime telemetry
```

In the future some radio events can be normalized as runtime events, but avoid a simultaneous refactor.

---

# 111. Integration with Durable State

Only verified state should end up in:

```text
.zelari/state/
```

The RunRecord can contain failed hypotheses.

Do not automatically promote everything.

---

# 112. Integration with `/compact`

`/compact` must become:

```text
typed CompactionState
```

but can continue to show the user a Markdown summary.

Backward compatibility:

```text
old session prose compact
-> supported
new sessions
-> typed state
```

---

# 113. Suggested file map - Core

Possible new files:

```text
packages/core/src/runtime/
|-> observers/
|   |-> types.ts
|   |-> ObserverBus.ts
|   |-> SteeringObserver.ts
|   |-> TraceObserver.ts
|   |-> MetricsObserver.ts
|
|-> guards/
|   |-> RepetitionGuard.ts
|   |-> FailureSignatureGuard.ts
|   |-> NoProgressGuard.ts
|   |-> DuplicateSearchGuard.ts
|
|-> controls/
|   |-> types.ts
|   |-> RuntimeControlQueue.ts
|
|-> recorder/
    |-> RunRecorder.ts
    |-> Redactor.ts
    |-> retention.ts
```

---

# 114. Suggested file map - Context

```text
packages/core/src/context/
|-> ContextPolicy.ts
|-> ContextProjector.ts
|-> RunRecord.ts
|-> RunRecordStore.ts
|-> ToolResultSpill.ts
|-> CompactionState.ts
|-> renderCompaction.ts
|-> tokenBudget.ts
```

---

# 115. Suggested file map - CLI/headless

Identify the current files that:

- parse `--headless`;
- print BrainEvents;
- manage AgentHarness.

Conceptually add:

```text
src/cli/headless/
|-> controlReader.ts
|-> protocol.ts
|-> controlBridge.ts
```

If headless is today all in a single file, first do a small extraction without changing its behavior.

---

# 116. Suggested file map - Desktop

```text
apps/desktop/src/
|-> activity/
|   |-> activityReducer.ts
|   |-> activitySelectors.ts
|   |-> types.ts
|
|-> components/
|   |-> KrakenActivity.tsx
|   |-> RunInspector.tsx
|   |-> RuntimeControls.tsx
|   |-> RuntimeWarningCard.tsx
|
|-> runtime/
    |-> controlClient.ts
    |-> protocolCapabilities.ts
```

Tauri:

```text
apps/desktop/src-tauri/src/
|-> run_manager.rs
|-> control.rs
|-> ...
```

If the project prefers to keep everything in `lib.rs`, start there but extract `RunManager` as soon as the feature is stable.

---

# 117. Test strategy

## Unit

```text
ObserverBus ordering
Intervention resolution
Repetition fingerprint
Failure signature normalization
NoProgress state
Control queue FIFO
ContextPolicy projection
Spill dedup
Compaction serialization
Redaction
Retention
```

---

# 118. ObserverBus tests

Cases:

```text
continue + continue -> continue

continue + retry -> retry

retry + stop -> stop

observer throw + ignore -> continue

observer throw + fail-closed -> stop/error
```

---

# 119. Steering tests

```text
steer during tool
-> not injected mid-tool
-> applied at next boundary

2 steers
-> preserved order

steer after last useful boundary
-> follow-up

cancel
-> no new tool scheduled
```

---

# 120. Kraken Graph steering test

```text
General A running
General B running
user steer
-> A/B finish or cancel only through existing policies
-> steer delivered to lead
-> future nodes see updated instruction
```

---

# 121. Runtime Guard tests

### Repetition

```text
same tool x2
-> warning

same tool x5
-> hard intervention
```

### Failure

```text
same normalized test failure x3
-> warning/inject
```

### Progress

```text
new completed task
-> reset stall count
```

---

# 122. Context tests

## Record/projection separation

```text
full tool output = 100k chars

RunRecord
-> contains pointer/full retained body

ProjectedContext
-> <= configured cap
```

---

# 123. Spill tests

```text
same body twice
-> one spill file

different body
-> different hash

empty body
-> no spill

path cannot be written by the file tool
```

---

# 124. Compaction tests

```text
serialize -> parse
```

must be lossless for typed fields.

Do not make tests based on Markdown regex as the source of truth.

---

# 125. Desktop tests

```text
Activity receives agent_spawned
-> row appears

agent_status completed
-> state changes

control_accepted
-> queue state accepted

control_applied
-> queued badge removed

old CLI protocol
-> steering disabled
```

---

# 126. E2E headless test

Spawn:

```text
zelari-code --headless --output json
```

write to stdin:

```json
{"type":"steer","id":"s1","text":"Do not edit files","ts":0}
```

wait for:

```text
control_accepted
control_applied
```

---

# 127. Flight Recorder E2E

Complete run:

```text
manifest exists
events exists
metrics exists
no API key in any file
```

---

# 128. Acceptance criteria - Phase 1

- [ ] `ObserverBus` exists.
- [ ] AgentHarness emits lifecycle callbacks.
- [ ] Observer error policies are tested.
- [ ] RepetitionGuard works.
- [ ] FailureSignatureGuard works.
- [ ] NoProgressGuard works.
- [ ] Runtime warnings are BrainEvents.
- [ ] No behavioral change with observers disabled.
- [ ] Existing unit tests stay green.

---

# 129. Acceptance criteria - Phase 2

- [ ] The headless protocol is bidirectional.
- [ ] `protocol_info` exposes capabilities.
- [ ] Desktop can send `steer`.
- [ ] `steer` is applied only at safe boundaries.
- [ ] In-flight tools are not broken.
- [ ] Multiple steers stay FIFO.
- [ ] The follow-up queue works.
- [ ] Cancel is cooperative.
- [ ] Old CLI fallback is handled.

---

# 130. Acceptance criteria - Phase 3

- [ ] Lead visible in Kraken Activity.
- [ ] Explore/General/Verify visible.
- [ ] Real model visible.
- [ ] Duration visible.
- [ ] Current tool visible.
- [ ] Worktree visible when present.
- [ ] Graph node visible.
- [ ] Tool details expandable.
- [ ] UI does not slow down with hundreds of events.

---

# 131. Acceptance criteria - Phase 4

- [ ] RunRecord and ProjectedContext are separated.
- [ ] Large tool outputs are spillable.
- [ ] Spill is content-addressed.
- [ ] Per-turn aggregate budget applied.
- [ ] Typed CompactionState implemented.
- [ ] ContextPolicy per role.
- [ ] Durable state stays separate.
- [ ] The existing provider prompt cache is not needlessly destabilized.

---

# 132. Acceptance criteria - Phase 5

- [ ] `.zelari/runs/<id>` created.
- [ ] manifest/trace/metrics saved.
- [ ] Agent trajectories available.
- [ ] Secrets redacted.
- [ ] Retention implemented.
- [ ] The Desktop Run Inspector reads the data.
- [ ] The active run is not deleted by cleanup.

---

# 133. Acceptance criteria - Phase 6

- [ ] The eval runner supports at least two arms.
- [ ] Environment per arm isolated.
- [ ] Pass/fail scorer available.
- [ ] Token/tool/duration metrics.
- [ ] Reproducible run metadata.
- [ ] Model-routing A/B executable.
- [ ] Runtime-guards A/B executable.
- [ ] Context A/B executable.

---

# 134. Recommended rollout

## Release A - Runtime Observability

Features:

```text
ObserverBus
TraceObserver
MetricsObserver
runtime_warning
```

No automatic intervention.

---

## Release B - Runtime Guards

Enable:

```text
RepetitionGuard
FailureSignatureGuard
NoProgressGuard
```

initially:

```text
warn-only
```

Then hard stop only for clear loops.

---

## Release C - Headless Protocol v2

Add:

```text
stdin ControlEvent
protocol_info
control acknowledgements
```

Without advanced UI.

---

## Release D - Desktop Steering

Add:

```text
Steer
Queue follow-up
Stop
Queued badge
```

---

## Release E - Kraken Activity

Add:

```text
agent events
activity panel
model routing visualization
```

---

## Release F - Context Engine v2

Behind:

```text
ZELARI_CONTEXT_V2=1
```

A/B before the default.

---

## Release G - Flight Recorder + Eval

Stabilize metrics and benchmarks.

---

# 135. Recommended feature flags

```text
ZELARI_RUNTIME_OBSERVERS=1
ZELARI_RUNTIME_GUARDS=1

ZELARI_HEADLESS_CONTROL=1
ZELARI_LIVE_STEERING=1

ZELARI_RUN_RECORD=1

ZELARI_CONTEXT_V2=1
ZELARI_TOOL_RESULT_SPILL=1
```

Do not keep feature flags forever.

After stabilization:

- remove superfluous flags;
- keep kill switches for high-impact features.

---

# 136. Suggested defaults at maturity

```text
Observer runtime          ON
Runtime guards            ON
Live steering             ON Desktop
Flight recorder           ON
Context v2                ON
Tool spill                ON
```

---

# 137. Practical priorities

## P0

Implement immediately:

```text
ObserverBus
Runtime Warning events
RepetitionGuard
FailureSignatureGuard
NoProgressGuard
```

Because:

- high impact;
- controllable architectural risk;
- enables the following phases.

---

## P1

Then:

```text
Headless Control v2
Steering
Kraken Activity
```

These give the Desktop the biggest UX leap.

---

## P1 / P2

Then:

```text
RunRecord
ContextProjection
Tool Spill
Typed Compaction
```

They have enormous impact on long runs, but touch the prompt lifecycle and require A/B.

---

## P2

Finally:

```text
Full Flight Recorder
Eval harness
```

The minimal recorder can arrive earlier; the full eval after.

---

# 138. Architectural decisions to formalize as ADRs

Create ADRs for:

```text
Observer intervention contract
Headless protocol v2
RunRecord vs ContextProjection
Tool spill storage policy
Runtime run-artifact schema
```

Example:

```text
docs/decisions/00xx-runtime-observer-bus.md
docs/decisions/00xx-headless-control-protocol.md
docs/decisions/00xx-run-record-context-projection.md
```

---

# 139. Non-goals

This specification does NOT propose:

- a new Agent Team system;
- replacing Kraken Graph;
- replacing Council;
- replacing `.zelari/state`;
- dynamic cross-provider routing;
- a remote distributed agent scheduler;
- violent process killing as a default;
- full chain-of-thought logging;
- storing credentials in the run recorder.

---

# 140. Privacy / reasoning trace

The runtime recorder must record:

```text
tool calls
tool results
assistant messages
system/runtime events
metrics
verification
```

It must not be designed to save the provider's private chain-of-thought.

If a provider returns separate reasoning fields:

- treat them according to the policies/provider contract;
- do not automatically render them in the UI;
- do not base the debugger on hidden reasoning.

---

# 141. Performance requirements

Observer:

```text
sync overhead target < 2 ms/event
```

Trace writer:

```text
buffered / async
```

Desktop Activity:

```text
virtualize / cap rendered events
```

Do not do a full chat rerender for every model delta.

---

# 142. Event batching

For streaming:

Do not necessarily send one Tauri event per token.

Batch:

```text
25-50 ms
```

or size:

```text
N chars
```

The Activity UI does not need model token deltas.

---

# 143. Atomic writes

For:

```text
manifest.json
metrics.json
graph.json
compactions/latest.json
```

use:

```text
write tmp
fsync if necessary
atomic rename
```

JSONL can be append-only.

---

# 144. Crash recovery

If Zelari crashes:

```text
manifest.status = running
```

at the next startup:

```text
detect stale
-> mark interrupted
```

Do not automatically declare `failed` if not known.

Status:

```text
interrupted
```

---

# 145. Session vs Run

Define:

```text
Session
-> persistent multi-turn conversation

Run
-> single execution of a task/user turn
```

Therefore:

```text
sessionId
runId
```

must be distinct.

---

# 146. Follow-up

A follow-up:

```text
same session
new runId
```

Steer:

```text
same runId
```

---

# 147. Tentacle run identity

Every tentacle:

```text
same root runId
unique agentId
```

Do not create a separate root run.

---

# 148. Metrics aggregation

Root metrics:

```text
sum tentacle tokens
sum model calls
sum tools
```

but keep the breakdown:

```text
lead
explore
general
verify
planner
```

---

# 149. Cost model

If the provider exposes prices or a local catalog exists:

```text
estimatedCost
```

Otherwise:

```text
null
```

Do not invent costs.

---

# 150. Final target experience

User starts:

```text
Kraken + Build
```

Prompt:

```text
Refactor the auth system while maintaining compatibility.
Verify with tests.
```

Desktop:

```text
KRAKEN ACTIVITY

@ Lead           ~
@ Explore #1     V
@ General #2     ~
@ Verify #3      queued
```

The user writes:

```text
Do not change the database structure.
```

Desktop:

```text
Steer queued
```

Kraken finishes the current tool.

Runtime:

```text
control_applied
```

The Lead receives the instruction.

General finishes its task.

FailureSignatureGuard sees:

```text
same auth test failed 3 times
```

injects:

```text
Reassess root cause.
```

Kraken changes strategy.

A 90k test output is:

```text
spilled
```

and only a preview enters the prompt.

Verify passes.

The Strict Gate receives evidence.

The run ends.

The Run Inspector shows:

```text
Duration         02:48
Tools            31
Tentacles         3
Warnings          1
Compactions       1
Spill             3
Peak context     68k
Verification     PASS
```

This is the target behavior.

---

# 151. Final condensed roadmap

```text
                    TODAY
                      |
                      v
             Kraken Model Routing
                      |
                      v
             Observer Runtime
                      |
             +--------+---------+
             |                  |
             v                  v
        Runtime Guards     Flight events
             |                  |
             +--------+---------+
                      v
              Headless Protocol v2
                      |
             +--------+---------+
             v                  v
          Steering        Kraken Activity
             |                  |
             +--------+---------+
                      v
                Context Engine v2
                      |
          +-----------+------------+
          v           v            v
       RunRecord   Tool Spill   Typed Compact
          |
          v
      Flight Recorder
          |
          v
        Zelari Eval
```

---

# 152. Conclusion

The most useful part of FrontierAgent for Zelari Code is not its multi-agent workflow.

The real opportunity is to build a runtime that is more:

- observable;
- steerable;
- resistant to loops;
- measurable;
- context-efficient;
- transparent in the Desktop.

The safest order is:

```text
Observer Bus
-> Runtime Guards
-> Steering
-> Activity
-> Context Engine
-> Flight Recorder
-> Evaluation
```

This sequence allows Zelari to keep Kraken as its distinguishing element, while making it far more controllable and verifiable in long multi-agent runs.

---

# 153. Technical references

FrontierAgent:

```text
https://github.com/ApodexAI/FrontierAgent
https://github.com/ApodexAI/FrontierAgent/blob/main/docs/framework.md
https://github.com/ApodexAI/FrontierAgent/blob/main/docs/tui-user-guide.md
https://github.com/ApodexAI/FrontierAgent/blob/main/docs/tool-result-truncation-ab.md
https://github.com/ApodexAI/FrontierAgent/blob/main/docs/context-offloading-followups.md
```

Zelari Code:

```text
https://github.com/N-THEM-Studio/zelari-code
https://github.com/N-THEM-Studio/zelari-code/blob/main/docs/GUIDA.md
https://github.com/N-THEM-Studio/zelari-code/tree/main/packages/core
https://github.com/N-THEM-Studio/zelari-code/tree/main/apps/desktop
```

---

# 154. Master implementation checklist

## Runtime Core

- [ ] Observer types
- [ ] ObserverBus
- [ ] Intervention resolution
- [ ] Failure policies
- [ ] AgentHarness lifecycle integration
- [ ] Runtime warning BrainEvent
- [ ] Runtime intervention BrainEvent

## Guards

- [ ] RepetitionGuard
- [ ] FailureSignatureGuard
- [ ] NoProgressGuard
- [ ] DuplicateSearchGuard
- [ ] Metrics
- [ ] warn-only rollout
- [ ] hard-stop policy

## Control plane

- [ ] ControlEvent schema
- [ ] stdin NDJSON reader
- [ ] protocol v2 handshake
- [ ] control accepted/applied/rejected
- [ ] RuntimeControlQueue
- [ ] SteeringObserver
- [ ] follow-up queue
- [ ] cancellation

## Desktop

- [ ] control client
- [ ] Steer button
- [ ] Queue follow-up
- [ ] Stop
- [ ] pending controls
- [ ] old CLI capability fallback
- [ ] tooltips

## Activity

- [ ] agent_spawned
- [ ] agent_status
- [ ] agent_tool
- [ ] agent_ended
- [ ] activity reducer
- [ ] Kraken Activity panel
- [ ] model
- [ ] duration
- [ ] scope
- [ ] worktree
- [ ] graph node
- [ ] expanded tool details

## Context

- [ ] RunRecord type
- [ ] RunRecordStore
- [ ] ContextPolicy
- [ ] ContextProjector
- [ ] role policies
- [ ] ToolResultSpill
- [ ] content hash
- [ ] aggregate budget
- [ ] recovery pointer
- [ ] Typed CompactionState
- [ ] compaction renderer
- [ ] backward compatibility `/compact`

## Recorder

- [ ] run directory
- [ ] manifest
- [ ] events
- [ ] trace
- [ ] metrics
- [ ] agents
- [ ] graph
- [ ] controls
- [ ] verification
- [ ] redaction
- [ ] retention
- [ ] crash recovery

## Eval

- [ ] eval runner
- [ ] eval case
- [ ] eval arm
- [ ] deterministic scorer
- [ ] model-routing experiment
- [ ] runtime-guard experiment
- [ ] context experiment
- [ ] reports
- [ ] reproducibility metadata

## QA

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build:cli`
- [ ] Desktop build
- [ ] Rust/Tauri tests
- [ ] headless E2E
- [ ] Windows smoke
- [ ] macOS smoke
- [ ] Linux smoke
