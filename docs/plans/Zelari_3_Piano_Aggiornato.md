# Zelari 3 --- Complete architectural evolution plan

**Document:** Technical and product plan\
**Target:** evolution from Zelari Code 2.14 to Zelari 3\
**Guiding principle:** *Zelari remains independent and sovereign. Other
environments may integrate Zelari; Zelari does not depend on other coding
harnesses.*\
**Status:** architectural proposal\
**Date:** August 28, 2026

------------------------------------------------------------------------

## 0. Executive summary

Zelari 3 must not be a rewrite and must not become a plugin for OpenCode,
Claude Code, Codex or Grok Build. It must be a **kernelization and
consolidation of the existing runtime**, transforming Zelari from an
advanced coding harness into an **independent platform for orchestrated,
verifiable agentic software-engineering missions**.

The goal is to preserve and strengthen what makes Zelari different:

-   proprietary, provider-neutral runtime;
-   Kraken and Kraken Graph;
-   Council;
-   autonomous missions;
-   shared memory;
-   deterministic verification;
-   checkpoints and recovery;
-   evals and regression gate;
-   LSP, AST, semantic search and tool engineering;
-   compatibility with providers, protocols and external tools without
    structural dependency.

The leap of Zelari 3 consists in clearly separating:

1.  **Agentic kernel/runtime** --- execution, context, tools,
    providers, permissions, events;
2.  **Orchestration layer** --- Mission, Kraken, DAG, Council, roles,
    scheduling, recovery;
3.  **Verification layer** --- acceptance criteria, deterministic gates,
    critic loop, evidence;
4.  **Platform layer** --- SDK, extension protocol, headless RPC,
    telemetry, Flight Recorder;
5.  **Clients/integrations** --- CLI, Desktop, editors, CI/CD,
    OpenCode/Claude/Codex bridges.

The fundamental architectural rule is:

> **OpenCode, Claude Code, Codex, Grok Build and future harnesses may
> become clients, workers or integrations of Zelari. They must not
> become foundations required for Zelari to work.**

The proposal avoids a big-bang rewrite. The migration must be
incremental, measured with A/B evals, and keep Zelari usable at every
stage.

------------------------------------------------------------------------

# 1. Vision for Zelari 3

## 1.1 Positioning

Zelari 3 should not primarily be presented as:

> "an open-source alternative to Claude Code".

The stronger positioning is:

> **Zelari is an independent agentic software-engineering runtime.**

Or:

> **Zelari turns coding agents into coordinated, verifiable
> software-engineering systems.**

The strategic distinction:

  -----------------------------------------------------------------------
  Category                           Primary function
  ----------------------------------- -----------------------------------
  Coding assistant                    Helps a programmer

  Coding agent                        Executes coding tasks

  Coding harness                      Provides runtime, tools and context
                                      to an agent

  Multi-agent harness                 Runs and coordinates multiple
                                      agents

  **Zelari 3**                        **Runs software missions with
                                      orchestration, verification,
                                      recovery and proof of completion**
  -----------------------------------------------------------------------

The central product concept therefore becomes **Mission**, not "chat"
and not even "agent".

------------------------------------------------------------------------

# 2. Non-negotiable principles

## 2.1 Sovereignty

Zelari must work fully without OpenCode, Claude Code, Codex or Grok
Build.

Test:

> If tomorrow we remove a specific external integration, does Zelari
> lose a fundamental capability?

If yes, the dependency is architecturally wrong.

## 2.2 Provider neutrality

No model may be semantically mandatory. Providers and models are
resources selectable by the runtime and the scheduler.

## 2.3 Open API, opinionated kernel

Third parties must be able to:

-   create missions;
-   observe events;
-   answer permissions;
-   pause/resume;
-   read graphs, artifacts and results;
-   add tools and integrations;
-   provide UIs.

They must not be able to implicitly corrupt kernel invariants.

## 2.4 Completion != model declaration

A model may propose `candidate_complete`.

Only a verification policy may produce `PASS`.

## 2.5 Run truth != model context

The complete history of the mission is a persistent source of truth.

The context sent to each model is a **derived, limited, role-specific
view**.

## 2.6 Adaptive orchestration

Do not use Council + Kraken + N workers for a three-line rename.

The runtime's complexity must adapt to:

-   difficulty;
-   risk;
-   parallelizability;
-   cost;
-   required confidence.

## 2.7 Evidence first

Architecture and release decisions must be validated through:

-   evals;
-   regression gate;
-   A/B benchmarks;
-   tracing;
-   failure taxonomy;
-   cost/latency metrics.

------------------------------------------------------------------------

# 3. Target architecture

``` text
+------------------------------------------------------------+
|                       ZELARI CLIENTS                        |
| CLI - Desktop - Web - VS Code - JetBrains - CI - Bridges   |
+------------------------------------------------------------+
                            |
                  Zelari Public Protocol
                            |
+------------------------------------------------------------+
|                     ZELARI PLATFORM                         |
| SDK - Headless RPC - Extensions - Flight Recorder - Eval   |
+------------------------------------------------------------+
                            |
+------------------------------------------------------------+
|                   ZELARI ORCHESTRATOR                       |
| Mission - Router - Kraken - Graph - Council - Budget       |
| Roles - Scheduling - Recovery - Memory - Completion Policy |
+------------------------------------------------------------+
                            |
+------------------------------------------------------------+
|                    ZELARI VERIFICATION                      |
| Acceptance - Critics - Tests - Lint - Types - Security     |
| Evidence - Deterministic Gates - Regression Checks          |
+------------------------------------------------------------+
                            |
+------------------------------------------------------------+
|                      ZELARI KERNEL                          |
| Agent Harness - Context Engine - Events - Intervention     |
| Tool Runtime - Permissions - Provider Runtime - Sessions   |
+------------------------------------------------------------+
               |                 |                |
          Providers           Tools          Workspace
       OpenAI/Anthropic      MCP/LSP/AST      Git/worktree
       Grok/etc.             Shell/browser    Filesystem
```

------------------------------------------------------------------------

# 4. Bounded contexts

## 4.1 Kernel

Responsibilities:

-   agent loop;
-   model dispatch;
-   tool lifecycle;
-   event emission;
-   session lifecycle;
-   permissions;
-   intervention;
-   context assembly interface;
-   provider interface;
-   cancellation;
-   timeout;
-   retry primitives.

The kernel **must not know about** Council, Kraken or product logic.

## 4.2 Context Engine

Responsibilities:

-   build context per role;
-   compaction;
-   retrieval;
-   salience;
-   context budgets;
-   artifact references;
-   typed summaries;
-   invalidation of stale memory.

Conceptual interface:

``` ts
interface ContextPolicy {
  build(input: ContextRequest): Promise<ModelContext>;
  compact(input: CompactionRequest): Promise<CompactedContext>;
}
```

Different policies:

-   `LeadContextPolicy`
-   `ExploreContextPolicy`
-   `BuilderContextPolicy`
-   `CriticContextPolicy`
-   `VerifierContextPolicy`
-   `CouncilContextPolicy`

## 4.3 Orchestrator

Responsibilities:

-   mission lifecycle;
-   decomposition;
-   dependency graph;
-   scheduling;
-   worker allocation;
-   escalation;
-   budgets;
-   pause/resume;
-   recovery;
-   completion policy.

## 4.4 Verification

It must be a domain separate from implementation.

Suggested order:

1.  deterministic checks;
2.  repository constraints;
3.  acceptance criteria;
4.  critic review;
5.  specialized checks;
6.  final completion policy.

## 4.5 Platform

Responsibilities:

-   public protocol;
-   SDK;
-   RPC;
-   extension API;
-   tracing;
-   telemetry;
-   replay;
-   eval harness.

------------------------------------------------------------------------

# 5. Mission as the primary API

The high-level public API must be mission-centric.

``` ts
const mission = await zelari.missions.create({
  objective: "Migrate authentication to OAuth while keeping compatibility",
  workspace: "/repo",
  autonomy: "full",
  acceptance: [
    "existing tests pass",
    "OAuth integration tests pass",
    "no public API regression"
  ],
  budget: {
    maxCostUsd: 15,
    maxMinutes: 45,
    maxParallelAgents: 6
  }
});
```

Minimal API:

``` text
missions.create
missions.get
missions.list
missions.pause
missions.resume
missions.cancel
missions.steer
missions.events
missions.artifacts
missions.graph
missions.verification
missions.checkpoints
missions.result
```

`AgentHarness` remains an important API for advanced embedding, but must
not be the product's main concept.

------------------------------------------------------------------------

# 6. Mission state machine

Suggested states:

``` text
CREATED
  v
ANALYZING
  v
PLANNED
  v
RUNNING
  +-- WAITING_APPROVAL
  +-- PAUSED
  +-- RECOVERING
  +-- VERIFYING
          +-- REPAIRING -> RUNNING
          +-- HOLD
          +-- PASSED
```

Terminals:

-   `PASSED`
-   `FAILED`
-   `CANCELLED`
-   `HOLD`

`HOLD` matters: exhausted budget or inability to verify must not be
falsely turned into success.

------------------------------------------------------------------------

# 7. Complexity Router

Before orchestrating, classify:

-   scope;
-   ambiguity;
-   risk;
-   dependency count;
-   expected file count;
-   architectural impact;
-   verification difficulty;
-   parallelization potential.

Routing:

``` text
TRIVIAL   -> single agent
NORMAL    -> agent + independent verifier
COMPLEX   -> Kraken
HIGH-RISK -> Kraken + specialist critics
AMBIGUOUS -> Council/design -> Kraken
EPIC      -> Council + hierarchical Kraken Graph
```

The router must be evaluable. Every decision gets recorded and compared
against real outcomes.

------------------------------------------------------------------------

# 8. Kraken 3

Kraken must evolve from "super-agent" to an **agentic mission
scheduler**.

Responsibilities:

-   decompose;
-   create the DAG;
-   assign roles;
-   choose model tiers;
-   allocate worktrees;
-   monitor progress;
-   recognize blockages;
-   replan;
-   escalate;
-   terminate useless workers;
-   request verification.

Kraken must not personally do all the work.

## 8.1 Node schema

``` yaml
id: auth-backend
goal: implement OAuth backend
role: backend-builder
depends_on:
  - auth-analysis
workspace: worktree
budget:
  tokens: 40000
  minutes: 15
verification:
  critic: backend-reviewer
  checks:
    - unit-tests
    - typecheck
    - acceptance-auth
max_rounds: 3
```

## 8.2 Scheduling

Priority computed using:

-   critical path;
-   dependency unlock value;
-   risk;
-   cost;
-   expected duration;
-   confidence;
-   workspace collision.

------------------------------------------------------------------------

# 9. Council 3

Council must not necessarily be a fixed pipeline.

Move to **dynamic role assembly**.

Example:

``` text
Mission: race condition in the transaction engine

Roles:
V concurrency specialist
V repository explorer
V test strategist
V critic

Not needed:
? product ideator
? documentation planner
```

The Council must answer one precise question:

> Which decision requires a plurality of perspectives before execution?

Use it for:

-   architecture;
-   ambiguous requirements;
-   high-risk migrations;
-   security boundaries;
-   alternative strategies.

Do not use it automatically for simple tasks.

------------------------------------------------------------------------

# 10. Role system

Separate `Role` from `AgentInstance`.

``` ts
type Role = {
  id: string;
  objective: string;
  instructions: string;
  allowedTools: string[];
  writePolicy: "none" | "scoped" | "full";
  contextPolicy: string;
  verificationPolicy?: string;
};
```

``` ts
type AgentInstance = {
  id: string;
  roleId: string;
  missionId: string;
  model: ModelRef;
  workspace: WorkspaceRef;
  budget: Budget;
  parentAgentId?: string;
};
```

Advantages:

-   reuse;
-   per-role evals;
-   model routing;
-   security;
-   parallelism;
-   A/B comparison.

------------------------------------------------------------------------

# 11. Builder--Critic Gauntlet

For important outputs:

``` text
Builder
  v
Candidate
  v
Fresh-context Critic
  v
Biggest gap
  +-- gap -> Builder round N+1
  +-- wins quality bar -> verification
```

Rules:

1.  the critic does not inherit the builder's reasoning;
2.  the critic receives the real output and the rubric;
3.  it must name the **single most important gap**;
4.  the builder receives the gap, not a full rewrite;
5.  configurable round limit;
6.  the deterministic gate remains the final authority.

The quality bar can be:

-   current baseline;
-   reference implementation;
-   architecture constraints;
-   acceptance tests;
-   benchmark;
-   blind A/B.

------------------------------------------------------------------------

# 12. Verification Engine

## 12.1 Check types

-   command;
-   test suite;
-   lint;
-   typecheck;
-   build;
-   diff policy;
-   file existence;
-   API compatibility;
-   schema compatibility;
-   security scanner;
-   browser test;
-   performance threshold;
-   custom assertion;
-   LLM critic;
-   human approval.

## 12.2 Evidence model

Every check produces:

``` ts
type VerificationEvidence = {
  checkId: string;
  status: "pass" | "fail" | "unknown";
  deterministic: boolean;
  timestamp: string;
  artifacts: ArtifactRef[];
  summary: string;
};
```

## 12.3 Completion

``` text
candidate_complete
        v
required evidence complete?
        v
   no -> continue/hold
        v yes
all hard gates pass?
        v
   no -> repair/fail
        v yes
soft confidence acceptable?
        v
   no -> critic/escalate
        v yes
      PASS
```

------------------------------------------------------------------------

# 13. Budget Scheduler

Budget as a first-class primitive:

``` ts
type Budget = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxMinutes?: number;
  maxTurns?: number;
  maxParallelAgents?: number;
};
```

Strategy:

-   cheap/fast model for simple discovery;
-   frontier reasoning for architecture;
-   coding-specialized model for implementation;
-   deterministic tools before LLM verification;
-   escalation only on failure/low confidence.

Metrics:

-   cost/pass;
-   tokens/pass;
-   wall-clock/pass;
-   agent-minutes;
-   retry count;
-   wasted work;
-   critical-path efficiency.

------------------------------------------------------------------------

# 14. Speculative execution

For high-uncertainty, verifiable decisions:

``` text
Strategy A -+
            +--> deterministic comparison -> winner
Strategy B -+
```

Use when:

-   implementation alternatives are cheap;
-   an objective quality bar exists;
-   the cost of discussion exceeds the cost of prototyping.

Do not use indiscriminately.

------------------------------------------------------------------------

# 15. Unified event model

Every component emits immutable events.

Examples:

``` text
MissionCreated
MissionPlanned
MissionSteered
AgentSpawned
AgentStopped
TurnStarted
ModelRequested
ModelResponded
ToolRequested
ToolStarted
ToolCompleted
ToolFailed
GraphNodeReady
GraphNodeStarted
GraphNodeCompleted
ContextBuilt
ContextCompacted
MemoryWritten
CheckpointCreated
VerificationStarted
VerificationEvidenceAdded
VerificationFailed
VerificationPassed
MissionCompleted
```

Envelope:

``` ts
type ZelariEvent<T> = {
  id: string;
  type: string;
  timestamp: string;
  runId: string;
  missionId?: string;
  agentId?: string;
  parentAgentId?: string;
  graphNodeId?: string;
  payload: T;
};
```

This becomes the nervous system for:

-   UI;
-   tracing;
-   replay;
-   telemetry;
-   extensions;
-   debugging;
-   eval.

------------------------------------------------------------------------

# 16. Observer & Intervention API

Observers:

``` text
onMissionStart
onTurnStart
onContextBuilt
onModelRequest
onModelResponse
onToolRequest
onToolResult
onVerification
onTurnEnd
onMissionEnd
```

Interventions:

``` text
continue
retry
stop
pause
replace
inject
deny_tool
require_approval
escalate_model
replan
```

Uses:

-   anti-loop;
-   cost guard;
-   security;
-   human steering;
-   policy enforcement;
-   experiment instrumentation.

------------------------------------------------------------------------

# 17. Anti-loop and no-progress detection

Signals:

-   same tool + same args repeated;
-   cyclically reverted edits;
-   identical error after N attempts;
-   no diff variation;
-   unchanged test failure;
-   context churn without artifacts;
-   repeated exploration over the same files.

Actions:

``` text
warn
summarize
change strategy
spawn critic
escalate model
rollback
replan
hold
```

------------------------------------------------------------------------

# 18. Context Engine

## 18.1 Sources

-   mission objective;
-   role;
-   recent turns;
-   relevant files;
-   symbol graph;
-   LSP;
-   AST;
-   semantic retrieval;
-   memory;
-   graph dependencies;
-   verifier evidence;
-   current diff.

## 18.2 Context budgets

Explicit allocation:

``` text
system/role       10%
mission state     10%
relevant code     45%
recent work       15%
memory             5%
verification      10%
reserve            5%
```

Dynamic, not rigid, percentages.

## 18.3 Typed compaction

Not "summarize the chat".

Produce structures:

``` text
decisions
constraints
open_questions
modified_files
known_failures
verified_facts
unverified_assumptions
next_actions
```

## 18.4 Context fingerprint

Record a hash of the context view for reproducibility and evals.

------------------------------------------------------------------------

# 19. Memory 3

Separate:

1.  **ephemeral working memory**
2.  **mission memory**
3.  **project memory**
4.  **verified knowledge**
5.  **user/team policy**

Every memory item:

``` text
source
confidence
scope
created_at
last_verified_at
expires/invalidates
evidence
```

Rule:

> Unverified memory must not silently turn into truth.

Support invalidation when the code changes.

------------------------------------------------------------------------

# 20. Workspace & worktree model

Primitives:

``` text
Workspace
WorkspaceSnapshot
Worktree
Checkpoint
Patch
Artifact
```

Policies:

-   explorer: read-only;
-   builder: scoped write;
-   critic: preferably read-only;
-   verifier: read-only except explicit fixtures;
-   parallel builders: isolated worktrees when collision risk >
    threshold.

Controlled and verified merge.

------------------------------------------------------------------------

# 21. Permission & security model

Levels:

``` text
read
workspace-write
external-network
credential-use
destructive
publish/deploy
full-access
```

Decision based on:

-   role;
-   mission policy;
-   tool;
-   target;
-   environment;
-   trust level.

Support:

-   allow;
-   deny;
-   ask;
-   allow-once;
-   allow-for-mission;
-   scoped allow.

Full audit via event log.

------------------------------------------------------------------------

# 22. Tool Runtime

Uniform tool contract:

``` ts
interface ZelariTool<I, O> {
  definition: ToolDefinition;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
```

Categories:

-   filesystem;
-   shell;
-   git;
-   LSP;
-   AST;
-   semantic;
-   browser;
-   MCP;
-   web;
-   custom.

Every tool must declare:

-   side effects;
-   permission class;
-   timeout;
-   idempotency;
-   concurrency safety;
-   output size policy.

------------------------------------------------------------------------

# 23. Provider Runtime

The provider adapter must normalize:

-   messages;
-   tool calls;
-   streaming;
-   reasoning controls;
-   token accounting;
-   context limits;
-   cancellation;
-   retries;
-   usage;
-   errors.

Capability discovery:

``` text
supports_tools
supports_parallel_tools
supports_reasoning
supports_images
supports_prompt_cache
supports_structured_output
max_context
```

The scheduler selects models by capability, not by hardcoded brand.

------------------------------------------------------------------------

# 24. Zelari Extension Protocol (ZEP)

Goal: allow other environments to integrate Zelari without owning its
runtime.

## 24.1 Client capabilities

``` text
createMission
sendInput
steer
pause
resume
cancel
subscribeEvents
answerPermission
inspectGraph
inspectAgents
retrieveArtifact
retrieveDiff
retrieveVerification
retrieveResult
```

## 24.2 Transport

Progressively support:

1.  in-process TypeScript SDK;
2.  stdio JSON-RPC;
3.  local socket;
4.  HTTP/WebSocket for remote deployment.

## 24.3 Versioning

Protocol version:

``` text
zep/1
```

Mandatory capability negotiation.

------------------------------------------------------------------------

# 25. External integrations

## 25.1 OpenCode

OpenCode can:

-   show mission UI;
-   send a workspace;
-   render events;
-   answer approvals;
-   show diffs/artifacts.

It does not own Kraken or Mission state.

## 25.2 Claude Code

Possible modes:

-   bridge command;
-   MCP-facing integration;
-   experimental worker adapter;
-   import/export of compatible skills.

## 25.3 Codex

Possible modes:

-   external worker;
-   CI/client integration;
-   worktree interoperability.

## 25.4 Grok Build

Possible modes:

-   skill compatibility;
-   worker bridge;
-   comparative eval.

No integration is required by the core.

------------------------------------------------------------------------

# 26. External worker adapters

Advanced, optional phase.

``` ts
interface ExternalWorkerAdapter {
  capabilities(): WorkerCapabilities;
  start(task: WorkerTask): Promise<WorkerHandle>;
  steer(handle: WorkerHandle, input: string): Promise<void>;
  stop(handle: WorkerHandle): Promise<void>;
  events(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
}
```

Zelari can then orchestrate:

``` text
native Zelari agent
Claude worker
Codex worker
OpenCode worker
custom enterprise worker
```

while keeping:

-   mission state;
-   the graph;
-   verification;
-   the budget;
-   completion authority.

------------------------------------------------------------------------

# 27. Flight Recorder

Every important run must be reconstructible.

Record:

-   mission config;
-   model/version;
-   provider;
-   prompts/instructions hash;
-   context fingerprint;
-   tool schema fingerprint;
-   events;
-   usage;
-   graph;
-   patches;
-   checkpoints;
-   verification;
-   final result.

Privacy/secrets:

-   redaction;
-   configurable retention;
-   local-only mode;
-   encrypted sensitive fields.

------------------------------------------------------------------------

# 28. Eval architecture

## 28.1 Eval dimensions

-   correctness;
-   completion;
-   regressions;
-   cost;
-   latency;
-   tool efficiency;
-   recovery;
-   context efficiency;
-   autonomy;
-   safety.

## 28.2 Benchmark families

``` text
micro-fix
bug-fix
feature
refactor
migration
cross-cutting change
security
performance
repository exploration
long-horizon mission
```

## 28.3 A/B

Comparisons:

``` text
single agent vs Kraken
Kraken vs Kraken Graph
fixed Council vs dynamic Council
context policy A vs B
model A vs B
critic off vs on
memory off vs on
```

Change one variable at a time.

------------------------------------------------------------------------

# 29. Harness manifest

Versioned fingerprint of:

-   tools;
-   schemas;
-   prompts;
-   policies;
-   context engine;
-   roles;
-   verifier config;
-   provider settings;
-   orchestration version.

Every eval must report the harness fingerprint.

------------------------------------------------------------------------

# 30. Regression gate

A release candidate does not pass if:

-   correctness drops beyond a threshold;
-   a hard benchmark regresses;
-   cost explodes without benefit;
-   latency degrades beyond budget;
-   a safety invariant fails.

Support documented exceptions with rationale.

------------------------------------------------------------------------

# 31. Observability dashboard

Mission metrics:

``` text
status
elapsed
cost
tokens
active agents
graph progress
critical path
verification status
failures
retries
checkpoints
```

Agent metrics:

``` text
role
model
task
turns
tokens
cost
tools
progress
current blocker
```

------------------------------------------------------------------------

# 32. Live progress page

CLI/TUI/Desktop must derive state from the event stream.

Example:

``` text
ZELARI MISSION - OAuth Migration

Overall              #######---  72%
Architecture          PASS
Backend               ROUND 2
Frontend              PASS
Compatibility         RUNNING
Security Critic       QUEUED
Integration Tests     BLOCKED

Agents: 4 active / 6 max
Cost: $6.41 / $12
Elapsed: 18m / 40m
```

Do not keep duplicated UI state when it can be derived from the runtime.

------------------------------------------------------------------------

# 33. Artifact model

First-class artifacts:

``` text
patch
diff
report
test-result
design
plan
screenshot
benchmark
log
binary
release-note
```

Every artifact:

-   id;
-   type;
-   producer;
-   mission;
-   graph node;
-   checksum;
-   path/reference;
-   evidence status.

------------------------------------------------------------------------

# 34. Checkpoint & recovery

Automatic checkpoints:

-   before high-risk edits;
-   before merges;
-   before migrations;
-   before destructive commands;
-   after a verified milestone.

Recovery strategies:

``` text
retry
rollback
fork strategy
change model
change role
spawn critic
replan node
replan graph
hold
```

------------------------------------------------------------------------

# 35. Failure taxonomy

Standardize:

``` text
MODEL_FAILURE
TOOL_FAILURE
PERMISSION_BLOCK
CONTEXT_FAILURE
LOOP_DETECTED
NO_PROGRESS
TEST_FAILURE
ARCHITECTURE_VIOLATION
MERGE_CONFLICT
BUDGET_EXHAUSTED
VERIFICATION_UNKNOWN
EXTERNAL_DEPENDENCY
USER_INTERRUPTION
```

This serves evals and automatic recovery.

------------------------------------------------------------------------

# 36. Package strategy

Avoid initial package explosion.

Pragmatic target:

``` text
@zelari/core
@zelari/orchestration
@zelari/protocol
@zelari/sdk
zelari-code
```

Possible later extraction:

``` text
@zelari/eval
@zelari/provider-*
@zelari/mcp
```

Rule: create a package only when a stable, useful API boundary exists.

------------------------------------------------------------------------

# 37. Dependency rules

``` text
protocol     -> no runtime dependencies
core         -> protocol
orchestration-> core + protocol
sdk          -> protocol
cli          -> sdk/orchestration
desktop      -> sdk/protocol
extensions   -> sdk/protocol
```

Forbidden:

``` text
core -> cli
core -> desktop
core -> OpenCode
core -> Claude Code
core -> Codex
orchestration -> UI
```

Enforcement via lint/architecture tests.

------------------------------------------------------------------------

# 38. Migration from the 2.14 codebase

## Phase A --- Architectural excavation

Before modifying:

-   real dependency graph;
-   import graph;
-   state ownership;
-   entry points;
-   agent loop;
-   context construction;
-   tool dispatch;
-   provider dispatch;
-   Kraken path;
-   Council path;
-   mission path;
-   verification path;
-   memory path;
-   headless path;
-   Desktop path;
-   test coverage.

Output:

`docs/architecture/current-state.md`

## Phase B --- Freeze public contracts

Define what must remain compatible.

Output:

`docs/architecture/compatibility-contract.md`

## Phase C --- Event spine

Introduce the event model without changing behavior.

Gate: same evals + same outputs.

## Phase D --- Observer/intervention

Extract policies from the loop.

Gate: agent loop regression-neutral.

## Phase E --- Context Engine

Separate run truth and model context.

Gate: quality >= baseline, token efficiency improved.

## Phase F --- Mission API

Mission becomes a public primitive.

The CLI keeps working through an adapter.

## Phase G --- Orchestration consolidation

Kraken/Council use the same kernel/event/context system.

## Phase H --- Verification Engine

Unify evidence and completion.

## Phase I --- Protocol/SDK

Make Zelari consumable by external clients.

## Phase J --- External extensions

VS Code/OpenCode/CI proof-of-concept.

------------------------------------------------------------------------

# 39. Proposed roadmap

## Milestone 0 --- Baseline & map

**Indicative duration:** 1--2 weeks

Deliverables:

-   architecture map;
-   dependency graph;
-   benchmark baseline;
-   harness manifest;
-   top failure modes;
-   compatibility matrix.

Exit gate:

> We can measure whether Zelari 3 improves or worsens Zelari 2.14.

## Milestone 1 --- Runtime Spine

**Duration:** 2--4 weeks

Deliverables:

-   unified event model;
-   run identity;
-   cancellation;
-   observer API;
-   intervention API;
-   tracing.

Exit gate:

> CLI and Kraken work without significant regressions.

## Milestone 2 --- Context Engine

**Duration:** 3--5 weeks

Deliverables:

-   ContextPolicy;
-   typed compaction;
-   role contexts;
-   context fingerprint;
-   token budgets.

Exit gate:

> >= baseline correctness with less context/token waste.

## Milestone 3 --- Mission Kernel

**Duration:** 3--5 weeks

Deliverables:

-   mission state machine;
-   public mission API;
-   pause/resume/steer;
-   artifacts;
-   checkpoints.

Exit gate:

> A mission can run headless without depending on the CLI.

## Milestone 4 --- Orchestration 3

**Duration:** 4--6 weeks

Deliverables:

-   Complexity Router;
-   Kraken scheduler;
-   dynamic Council;
-   Role/AgentInstance split;
-   budget scheduler;
-   graph recovery.

Exit gate:

> Kraken demonstrates a measurable advantage on complex benchmarks.

## Milestone 5 --- Verification 3

**Duration:** 3--4 weeks

Deliverables:

-   evidence model;
-   builder/critic;
-   deterministic gates;
-   acceptance DSL;
-   completion policy.

Exit gate:

> No mission is marked PASS without the required evidence.

## Milestone 6 --- Zelari Protocol & SDK

**Duration:** 3--5 weeks

Deliverables:

-   ZEP/1;
-   TypeScript SDK;
-   stdio RPC;
-   event streaming;
-   permission channel.

Exit gate:

> A minimal external client can drive a complete mission.

## Milestone 7 --- Ecosystem

**Duration:** iterative

Deliverables:

-   VS Code prototype;
-   CI adapter;
-   OpenCode integration;
-   external worker experiments;
-   extension docs.

Exit gate:

> At least two non-Zelari clients can use Zelari without internal
> dependencies.
------------------------------------------------------------------------

# 40. Priority sequence

Recommended order:

``` text
1. Measure
2. Map
3. Events
4. Intervention
5. Context
6. Mission
7. Verification
8. Orchestration
9. Protocol
10. Extensions
11. External workers
```

Do not start with UI or a marketplace.

------------------------------------------------------------------------

# 41. What NOT to do

## 41.1 Do not rewrite everything

Risks:

-   regressions;
-   loss of edge cases;
-   months without user value;
-   impossibility of A/B.

## 41.2 Do not increase the number of agents as a goal

More agents != better harness.

Optimize:

``` text
quality / cost / latency
```

## 41.3 Do not make Council mandatory

Use it only when it adds value.

## 41.4 Do not depend on an external harness

Compatibility yes; dependency no.

## 41.5 Do not confuse telemetry with memory

Telemetry describes what happened.

Memory influences future decisions.

## 41.6 Do not allow "PASS by narrative"

"I completed the task" is not evidence.

------------------------------------------------------------------------

# 42. KPIs

## Quality

-   benchmark pass rate;
-   regression rate;
-   acceptance pass;
-   human correction rate.

## Efficiency

-   median cost/pass;
-   p95 cost/pass;
-   tokens/pass;
-   wall clock;
-   parallel efficiency.

## Autonomy

-   intervention rate;
-   permission rate;
-   recovery success;
-   mission completion without human steer.

## Reliability

-   false PASS rate;
-   false HOLD rate;
-   crash recovery;
-   replay consistency.

The most important metric:

> **False PASS rate must tend to zero.**

------------------------------------------------------------------------

# 43. Release criteria for Zelari 3.0

Zelari 3.0 should not be declared such until:

-   [ ] the Mission API is stable;
-   [ ] the event model is stable;
-   [ ] run truth is separated from context;
-   [ ] Kraken and Council use the shared kernel;
-   [ ] verification evidence is first-class;
-   [ ] the completion gate does not depend on model narrative;
-   [ ] headless execution is complete;
-   [ ] a public SDK exists;
-   [ ] ZEP/1 is versioned;
-   [ ] the CLI is a client of the runtime, not the owner of its state;
-   [ ] Desktop is a client of the runtime;
-   [ ] the eval regression gate is mandatory;
-   [ ] at least one external integration demonstrates the protocol;
-   [ ] no external harness is a fundamental dependency;
-   [ ] a 2.x migration guide is available.

------------------------------------------------------------------------

# 44. 2.x compatibility

Strategy:

-   gradual deprecations;
-   compatibility facade;
-   warnings before removal;
-   codemods where possible;
-   "2.x -> 3.x" documentation.

Temporarily keep:

``` text
AgentHarness legacy facade
existing CLI commands
existing config
existing skills
existing MCP config
```

with translation towards the new kernel.

------------------------------------------------------------------------

# 45. Testing strategy

## Unit

-   scheduler;
-   state machines;
-   policies;
-   context;
-   permissions;
-   verification.

## Integration

-   provider + tool;
-   Kraken graph;
-   Council;
-   checkpoint;
-   memory;
-   protocol.

## Replay

Recorded runs replayable against updated components.

## Chaos

Simulate:

-   provider timeouts;
-   malformed tool output;
-   process crashes;
-   permission denied;
-   worktree conflicts;
-   test flakiness;
-   context overflow.

------------------------------------------------------------------------

# 46. Security

Explicit threat model for:

-   prompt injection;
-   malicious repository;
-   poisoned MCP;
-   credential exfiltration;
-   destructive shell;
-   dependency confusion;
-   extension abuse;
-   memory poisoning.

Security invariants must be testable.

------------------------------------------------------------------------

# 47. Extension trust model

Categories:

``` text
trusted
sandboxed
untrusted
```

Manifest:

``` yaml
name: example-extension
permissions:
  - mission.read
  - events.subscribe
  - artifact.read
  - tool.register
```

No implicit access to the entire runtime.

------------------------------------------------------------------------

# 48. Configuration

Hierarchy:

``` text
defaults
global user
project
mission
runtime override
```

Every value must be able to report its provenance for debugging.

------------------------------------------------------------------------

# 49. Developer experience

Target commands:

``` text
zelari mission run
zelari mission status
zelari mission pause
zelari mission resume
zelari mission steer
zelari mission inspect
zelari graph
zelari agents
zelari verify
zelari replay
zelari eval
zelari doctor
```

Debug:

``` text
zelari inspect context <agent>
zelari inspect events
zelari inspect budget
zelari inspect evidence
```

------------------------------------------------------------------------

# 50. Repository governance

For kernel changes, require:

-   architecture note;
-   tests;
-   eval delta;
-   benchmark cost delta;
-   backward compatibility note.

ADRs for irreversible decisions.

Suggested directory:

``` text
docs/
  architecture/
  adr/
  protocol/
  eval/
  migration/
```

------------------------------------------------------------------------

# 51. Development gauntlet for Zelari 3

Every important component follows:

``` text
baseline
   v
builder implementation
   v
independent critic
   v
largest gap
   v
revision
   v
A/B eval
   v
regression gate
   v
merge
```

Critic rubric:

1.  correctness;
2.  simplicity;
3.  isolation;
4.  observability;
5.  testability;
6.  backward compatibility;
7.  cost;
8.  failure behavior.

The critic must compare against a concrete baseline, not against
impressions.

------------------------------------------------------------------------

# 52. Workstream decomposition

## WS1 --- Architecture & dependency boundaries

Owner: core architecture

## WS2 --- Event/observer runtime

Owner: runtime

## WS3 --- Context engine

Owner: context/retrieval

## WS4 --- Mission state & orchestration

Owner: agent systems

## WS5 --- Verification/evidence

Owner: reliability

## WS6 --- Protocol/SDK

Owner: platform

## WS7 --- Eval/Flight Recorder

Owner: quality

## WS8 --- CLI/Desktop migration

Owner: product clients

## WS9 --- Extensions/integrations

Owner: ecosystem

Independent workstreams where possible, with contract-first development.

------------------------------------------------------------------------

# 53. Decisions to validate before coding

1.  Event store: JSONL, SQLite or dual?
2.  Mission persistence schema?
3.  Initial ZEP transport?
4.  Do in-process API and RPC share the same DTOs?
5.  Context compaction deterministic or model-assisted?
6.  Dynamic Council: rule-based, model-routed or hybrid?
7.  Budget scheduler: heuristic first, learned later?
8.  Worktree isolation default for which classes?
9.  Extension sandbox?
10. External workers included in 3.0 or post-3.0?

------------------------------------------------------------------------

# 54. Recommended decisions

### Event persistence

SQLite for queries + JSONL export for portability/replay.

### Protocol

Shared TypeScript DTOs + stdio JSON-RPC as the first external transport.

### Context

Hybrid: deterministic structure, model-assisted summarization.

### Complexity Router

Heuristic + model classification, with deterministic override.

### Budget scheduler

Heuristic in 3.0; adaptive/learned only after sufficient data.

### External workers

Post-3.0 except for a proof-of-concept.

### Extension ecosystem

Protocol in 3.0; marketplace later.

------------------------------------------------------------------------

# 55. Main risks

## R1 --- Overengineering

Mitigation: every new layer must demonstrate value in evals.

## R2 --- Package explosion

Mitigation: bounded contexts first, packages later.

## R3 --- Multi-agent cost explosion

Mitigation: Complexity Router + budgets.

## R4 --- Context regressions

Mitigation: fingerprint + replay + A/B.

## R5 --- False PASS

Mitigation: deterministic evidence.

## R6 --- API freeze too early

Mitigation: `experimental` namespace until stabilization.

## R7 --- Extension attack surface

Mitigation: permissions + sandbox + manifests.

## R8 --- Endless migration

Mitigation: usable vertical milestones.

------------------------------------------------------------------------

# 56. Definition of Done for each milestone

A milestone is complete only if:

-   code merged;
-   tests green;
-   docs updated;
-   evals run;
-   cost delta known;
-   regression gate passed;
-   migration impact documented;
-   observability available;
-   rollback possible.

------------------------------------------------------------------------

# 57. First concrete sprint

## Days 1--2

-   generate the import/dependency graph;
-   map entry points;
-   map state ownership;
-   catalog runtime loops.

## Days 3--4

-   map Kraken/Council/Mission execution;
-   map verification;
-   map context;
-   map headless/Desktop boundaries.

## Day 5

-   current-state architecture doc;
-   top 10 coupling problems;
-   target dependency rules.

## Week 2

-   baseline eval suite;
-   minimal Flight Recorder;
-   event envelope;
-   non-invasive instrumentation.

Sprint output:

``` text
docs/architecture/current-state.md
docs/architecture/target-state.md
docs/architecture/dependency-rules.md
docs/adr/0001-event-spine.md
eval/baseline-3.0.json
```

------------------------------------------------------------------------

# 58. Second sprint

Implement the event spine without changing semantics.

Targets:

``` text
AgentHarness
Kraken
Council
Mission
Verification
```

emit coherent events.

Do not introduce new agentic features yet.

This creates the observable base needed for all subsequent changes.

------------------------------------------------------------------------

# 59. Branch/release strategy

Suggestion:

``` text
main          -> stable
next          -> Zelari 3 integration
feature/*     -> workstreams
```

Releases:

``` text
2.15/2.16 -> compatible backports
3.0-alpha -> runtime spine + mission API
3.0-beta  -> orchestration + verification + SDK
3.0-rc    -> migration + ecosystem proof
3.0       -> stable contracts
```

Avoid a long-lived non-integrated branch.

------------------------------------------------------------------------

# 60. North-star architecture

The final shape:

``` text
                     +---------------+
                     |     USER      |
                     +---------------+
                             |
                       Any Zelari Client
                             |
                       ZEP / Zelari SDK
                             |
                     +---------------+
                     |    MISSION    |
                     +---------------+
                             |
                    Complexity Router
                             |
           +-----------------+------------------+
           |                 |                  |
      Single Agent         Kraken            Council
                             |                  |
                             +--------+---------+
                                      |
                                  Kraken DAG
                                      |
                 +--------------------+--------------------+
                 |                    |                    |
              Explorer             Builder              Critic
                 |                    |                    |
                 +--------------------+--------------------+
                                      |
                               Verification
                                      |
                              +-------+-------+
                              |               |
                            FAIL             PASS
                              |               |
                         repair/replan    Mission Complete
```

Underneath everything:

``` text
Zelari Kernel
  |- Event Runtime
  |- Context Engine
  |- Provider Runtime
  |- Tool Runtime
  |- Permissions
  |- Memory
  |- Workspace
  |- Flight Recorder
```

------------------------------------------------------------------------

# 61. Final strategic criterion

Every new feature must answer one of the following questions:

1.  Does it increase the probability that a mission is correct?
2.  Does it reduce the cost per correct mission?
3.  Does it reduce the time to a correct mission?
4.  Does it increase observability or recovery capability?
5.  Does it improve Zelari's independence or extensibility?

If the answer is "no" to all, it probably does not belong in the core.

------------------------------------------------------------------------

# 62. Conclusion

Zelari 3 must be an evolution of the existing base, not a replacement.

The priority is not adding more agents. It is building a **coherent,
observable, verifiable and programmable runtime** in which agents,
Kraken and Council are strategies over the same primitives.

Zelari's technical moat should concentrate on:

``` text
Mission orchestration
+ adaptive scheduling
+ role-specific context
+ independent criticism
+ deterministic verification
+ recovery
+ eval-driven evolution
```

The strategic moat must be:

``` text
independent runtime
+ provider neutrality
+ public protocol
+ external integrations without dependency
```

The sentence that synthesizes Zelari 3:

> **Zelari must not simply run agents. It must take a software mission,
> organize the necessary work, produce verifiable evidence and know when
> the result is actually complete.**

And the rule that protects the project's independence:

> **Others may install Zelari, invoke Zelari or work for Zelari. Zelari
> must not need them in order to be Zelari.**

---

# 63. Architectural update - Model Intelligence & Native Wire

## 63.1 New principle: provider neutrality without model homogenization

Zelari 3 must stay provider-neutral without reducing all models to the lowest common denominator. A common semantic API must be compiled to the native behavior of the selected model family and provider.

```text
Zelari semantic intent
  reasoning: HIGH
  latency: FAST
  tool mode: AGGRESSIVE
        |
        v
Model Intelligence Layer
        |
  +-----+-----+
  |     |     |
Claude GPT   Grok
  |     |     |
  v     v     v
native wire/native policy
```

## 63.2 Separate Provider, Model Family and Wire Policy

The runtime must not treat `provider` and `model` as synonyms. We introduce three distinct concepts:

- **ProviderAdapter**: transport, authentication, streaming, errors, usage and API primitives.
- **ModelProfile**: capabilities, limits, cost, latency class, strengths and eval results.
- **WirePolicy**: translation of Zelari intent into the model's native parameters, tool dialect, reasoning controls, prompt conventions and other native semantics.

## 63.3 ModelProfile

Conceptual schema:

```yaml
id: model-id
family: claude
provider: anthropic
capabilities:
  coding: 0.97
  reasoning: 0.99
  exploration: 0.92
  verification: 0.96
context:
  max: 200000
reasoning:
  supported: true
  mechanism: adaptive
tools:
  supported: true
  parallel: true
cost:
  class: premium
latency:
  class: medium
qualification:
  wire_verified: true
  eval_manifest: sha256:...
```

Empirical scores must come from Zelari evals and not be confused with provider-declared capabilities.

## 63.4 Capability Registry

The registry must distinguish:

1. declared capability;
2. syntactically accepted capability;
3. behaviorally verified capability;
4. performance observed in evals.

An HTTP 200 is not proof that a capability was applied.

## 63.5 Fail closed on capabilities

When a mission requires a property that cannot be guaranteed:

```text
requested capability
       |
       v
verified support?
   +---+---+
  YES     NO
   |       |
execute   explicit downgrade / alternate model / reject
```

Zelari must not declare a reasoning level, tool mode or other control active if the backend cannot prove its application.

## 63.6 Model-native execution

The common API must express Zelari intents, for example:

```ts
{
  reasoning: "high",
  latencyPreference: "fast",
  toolStrategy: "aggressive",
  structuredOutput: true
}
```

The WirePolicy produces the appropriate configuration for the concrete family.

## 63.7 Capability-based Model Scheduler

Kraken should not necessarily require a model ID. It should be able to request capabilities:

```ts
spawnAgent({
  role: "explorer",
  requiredCapabilities: {
    codeNavigation: "high",
    reasoning: "medium",
    speed: "high"
  },
  budgetClass: "cheap"
});
```

The Model Scheduler picks the candidate using:

- capability qualification;
- role eval score;
- cost;
- latency;
- availability;
- context requirement;
- risk;
- remaining budget;
- provider health.

## 63.8 Model escalation

The initial model need not be the most expensive. Strategy:

```text
cheap qualified model
       |
       +-- success -> verify
       |
       +-- low confidence/failure
                 |
            stronger model
                 |
                 +-- persistent failure -> specialist/replan
```

Escalation must be recorded in the Flight Recorder.

# 64. Model Probe

Add:

```text
zelari model probe <provider/model>
```

The probe should test, where possible:

- completion;
- streaming;
- tool calling;
- parallel tool calling;
- structured output;
- reasoning controls;
- cancellation;
- context behavior;
- error semantics;
- usage accounting;
- latency;
- provider-specific controls.

Indicative output:

```text
MODEL PROBE

Completion          PASS
Streaming           PASS
Tools               PASS
Parallel tools      FAIL
Reasoning LOW       PASS
Reasoning HIGH      PASS
Reasoning XHIGH     UNSUPPORTED
Structured output   PASS

Qualification: 87/100
```

# 65. Model Qualification Suite

Before marking a model as officially qualified:

```text
Wire Probe
   v
Capability Probe
   v
Coding Micro-Evals
   v
Tool-Use Eval
   v
Context Eval
   v
Recovery Eval
   v
Kraken Worker Eval
   v
QUALIFIED
```

The suite generates a versioned, signed/hashed manifest.

# 66. Model Drift Detection

Providers and models can change without Zelari modifications. The runtime must detect drift in:

- schema;
- capabilities;
- tool behavior;
- reasoning behavior;
- latency;
- error patterns;
- context behavior.

Significant drift invalidates the previous qualification and can trigger targeted regression evals.

# 67. Zelari Doctor 3

`zelari doctor` must become a runtime diagnostic, not just an installation one.

```text
ZELARI DOCTOR

Runtime                 PASS
Harness manifest        PASS
Environment drift       NONE
Provider Anthropic      PASS
Provider OpenAI         PASS
Provider xAI            PASS
Model profiles          VERIFIED
MCP                     PASS
LSP                     PASS
Verification runtime    PASS
Event store             PASS
```

It must distinguish warnings, degraded and hard failures.

# 68. New Workstream WS10 - Model Intelligence & Native Wire

Deliverables:

- ModelProfile schema;
- Capability Registry;
- WirePolicy interface;
- native policy for the main families;
- model probe;
- qualification suite;
- behavioral evidence;
- drift detection;
- model benchmark registry;
- provider health;
- capability-based model routing.

Exit gate:

> Zelari can select and use different models without homogenizing their capabilities and without declaring unverified support.

# 69. Updated target architecture

```text
Clients / Extensions
        |
        v
ZEP + SDK
        |
        v
Mission Runtime
        |
        v
Complexity Router
        |
        v
Kraken / Council / Single Agent
        |
        v
Role + Capability Request
        |
        v
Model Scheduler
        |
        +----------------- Eval Registry
        +----------------- Budget Scheduler
        +----------------- Provider Health
        |
        v
Model Intelligence Layer
        |
        +-- ModelProfile
        +-- Capability Registry
        +-- WirePolicy
        |
        v
Provider Runtime
        |
   +----+----+----+----+
   |    |    |    |    |
OpenAI Anthropic xAI Other
```

The Model Intelligence Layer remains internal to Zelari and independent of any external harness.

# 70. Updated roadmap

Insert WS10 in parallel after Runtime Spine and before completing Orchestration 3.

Updated order:

```text
1. Measure & repository excavation
2. Event spine
3. Observer/intervention
4. Context Engine
5. Mission Kernel
6. Model Intelligence foundation
7. Verification Engine
8. Kraken/Council Orchestration 3
9. Model qualification + capability scheduler
10. ZEP/SDK
11. Extensions
12. External workers
```

Rationale: the Kraken scheduler must be designed directly on real capabilities instead of being refactored later from model-ID routing to capability routing.

# 71. Additional milestone - Model Intelligence

**Indicative duration:** 3-5 weeks, partially parallel.

Deliverables:

- provider/model/wire separation;
- ModelProfile;
- WirePolicy;
- Capability Registry;
- `zelari model probe`;
- qualification manifest;
- first per-role evals;
- fail-closed capability handling.

Exit gate:

> At least three model families can execute the same Zelari semantic intent through verified native policies, with a reproducible capability manifest.

# 72. Additional KPIs for Model Intelligence

- qualification pass rate;
- behavioral capability confidence;
- model drift incidents;
- role-specific pass rate;
- cost/pass per model and role;
- latency/pass;
- escalation rate;
- false capability declaration rate;
- scheduler regret: the difference between the chosen model and the best model known post-eval.

Critical target:

> **False capability declaration rate = 0 for hard-gated capabilities.**

# 73. Updated technical moat

The Zelari 3 moat becomes:

```text
Mission orchestration
+ adaptive scheduling
+ role-specific context
+ independent criticism
+ deterministic verification
+ recovery
+ model intelligence
+ model-native execution
+ empirical qualification
+ eval-driven evolution
```

The independence principle becomes:

> **Provider neutrality without model homogenization.**

Zelari must be able to use the best of every model without turning into a wrapper for any provider or harness.

# 74. Updated final formula

Zelari 3 must work as a system with four levels of intelligence:

```text
MISSION INTELLIGENCE
What must be achieved?
        |
ORCHESTRATION INTELLIGENCE
How do we divide, coordinate and verify the work?
        |
MODEL INTELLIGENCE
Which model is best suited to each job and how should it be driven natively?
        |
EXECUTION INTELLIGENCE
Which tools, workspace, context and recovery are needed to complete it?
```

Completion remains governed by evidence:

```text
Model says done
      !=
Mission complete

Candidate
   v
Evidence
   v
Independent criticism
   v
Deterministic verification
   v
PASS
```

The updated vision can be summarized as:

> **Zelari is an independent runtime for software-engineering missions that orchestrates agents and models according to their real capabilities, drives them according to their native semantics, empirically verifies what they produce, and considers the work complete only when sufficient evidence exists to prove it.**