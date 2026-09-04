# Zelari 3 --- Piano completo di evoluzione architetturale

**Documento:** Piano tecnico e di prodotto\
**Target:** evoluzione da Zelari Code 2.14 a Zelari 3\
**Principio guida:** *Zelari rimane indipendente e sovrano. Gli altri
ambienti possono integrare Zelari; Zelari non dipende da altri coding
harness.*\
**Stato:** proposta architetturale\
**Data:** 28 agosto 2026

------------------------------------------------------------------------

## 0. Executive summary

Zelari 3 non deve essere una riscrittura e non deve diventare un plugin
di OpenCode, Claude Code, Codex o Grok Build. Deve essere una
**kernelizzazione e consolidazione del runtime esistente**, trasformando
Zelari da coding harness avanzato in una **piattaforma indipendente per
missioni di software engineering agentiche, orchestrate e
verificabili**.

L'obiettivo è preservare e rafforzare ciò che rende Zelari differente:

-   runtime proprietario e provider-neutral;
-   Kraken e Kraken Graph;
-   Council;
-   missioni autonome;
-   memoria condivisa;
-   verificazione deterministica;
-   checkpoint e recovery;
-   eval e regression gate;
-   LSP, AST, semantic search e tool engineering;
-   compatibilità con provider, protocolli e strumenti esterni senza
    dipendenza strutturale.

Il salto di Zelari 3 consiste nel separare chiaramente:

1.  **Kernel/runtime agentico** --- esecuzione, context, tools,
    provider, permissions, events;
2.  **Orchestration layer** --- Mission, Kraken, DAG, Council, ruoli,
    scheduling, recovery;
3.  **Verification layer** --- acceptance criteria, deterministic gates,
    critic loop, evidence;
4.  **Platform layer** --- SDK, protocollo estensioni, headless RPC,
    telemetry, Flight Recorder;
5.  **Clients/integrations** --- CLI, Desktop, editor, CI/CD,
    OpenCode/Claude/Codex bridges.

La regola architetturale fondamentale è:

> **OpenCode, Claude Code, Codex, Grok Build e futuri harness possono
> diventare client, worker o integrazioni di Zelari. Non devono
> diventare fondamenta necessarie al funzionamento di Zelari.**

La proposta evita una riscrittura big-bang. La migrazione deve essere
incrementale, misurata con eval A/B e mantenere Zelari utilizzabile in
ogni fase.

------------------------------------------------------------------------

# 1. Visione di Zelari 3

## 1.1 Posizionamento

Zelari 3 non dovrebbe essere presentato principalmente come:

> "un'alternativa open-source a Claude Code".

Il posizionamento più forte è:

> **Zelari is an independent agentic software-engineering runtime.**

Oppure:

> **Zelari turns coding agents into coordinated, verifiable
> software-engineering systems.**

La distinzione strategica:

  -----------------------------------------------------------------------
  Categoria                           Funzione primaria
  ----------------------------------- -----------------------------------
  Coding assistant                    Aiuta un programmatore

  Coding agent                        Esegue task di coding

  Coding harness                      Fornisce runtime, tool e context a
                                      un agente

  Multi-agent harness                 Esegue e coordina più agenti

  **Zelari 3**                        **Esegue missioni software con
                                      orchestrazione, verifica, recovery
                                      e prove di completamento**
  -----------------------------------------------------------------------

Il concetto centrale del prodotto diventa quindi **Mission**, non "chat"
e neppure "agent".

------------------------------------------------------------------------

# 2. Principi non negoziabili

## 2.1 Sovranità

Zelari deve funzionare integralmente senza OpenCode, Claude Code, Codex
o Grok Build.

Test:

> Se domani eliminiamo una specifica integrazione esterna, Zelari perde
> una capability fondamentale?

Se sì, la dipendenza è architetturalmente errata.

## 2.2 Provider neutrality

Nessun modello deve essere semanticamente obbligatorio. Provider e
modelli sono risorse selezionabili dal runtime e dallo scheduler.

## 2.3 API aperta, kernel opinionated

Terze parti devono poter:

-   creare missioni;
-   osservare eventi;
-   rispondere alle permission;
-   mettere in pausa/riprendere;
-   leggere graph, artifacts e risultati;
-   aggiungere tool e integrazioni;
-   fornire UI.

Non devono poter corrompere implicitamente le invarianti del kernel.

## 2.4 Completion ≠ dichiarazione del modello

Un modello può proporre `candidate_complete`.

Solo una policy di verifica può produrre `PASS`.

## 2.5 Run truth ≠ model context

La storia completa della missione è una fonte di verità persistente.

Il contesto inviato a ciascun modello è una **vista derivata, limitata e
specifica per ruolo**.

## 2.6 Orchestrazione adattiva

Non usare Council + Kraken + N worker per un rename di tre righe.

La complessità del runtime deve adattarsi a:

-   difficoltà;
-   rischio;
-   parallelizzabilità;
-   costo;
-   confidence richiesta.

## 2.7 Evidence first

Decisioni di architettura e release devono essere validate tramite:

-   eval;
-   regression gate;
-   benchmark A/B;
-   tracing;
-   failure taxonomy;
-   cost/latency metrics.

------------------------------------------------------------------------

# 3. Architettura target

``` text
┌─────────────────────────────────────────────────────────────┐
│                       ZELARI CLIENTS                        │
│ CLI │ Desktop │ Web │ VS Code │ JetBrains │ CI │ Bridges  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                  Zelari Public Protocol
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     ZELARI PLATFORM                         │
│ SDK │ Headless RPC │ Extensions │ Flight Recorder │ Eval   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                   ZELARI ORCHESTRATOR                       │
│ Mission │ Router │ Kraken │ Graph │ Council │ Budget       │
│ Roles │ Scheduling │ Recovery │ Memory │ Completion Policy │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                    ZELARI VERIFICATION                      │
│ Acceptance │ Critics │ Tests │ Lint │ Types │ Security     │
│ Evidence │ Deterministic Gates │ Regression Checks          │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      ZELARI KERNEL                          │
│ Agent Harness │ Context Engine │ Events │ Intervention     │
│ Tool Runtime │ Permissions │ Provider Runtime │ Sessions    │
└──────────────┬─────────────────┬────────────────┬───────────┘
               │                 │                │
          Providers           Tools          Workspace
       OpenAI/Anthropic      MCP/LSP/AST      Git/worktree
       Grok/etc.             Shell/browser    Filesystem
```

------------------------------------------------------------------------

# 4. Bounded contexts

## 4.1 Kernel

Responsabilità:

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

Il kernel **non deve conoscere** Council, Kraken o logica di prodotto.

## 4.2 Context Engine

Responsabilità:

-   costruire il contesto per ruolo;
-   compaction;
-   retrieval;
-   salience;
-   context budgets;
-   artifact references;
-   summaries tipizzati;
-   invalidazione di memoria obsoleta.

Interfaccia concettuale:

``` ts
interface ContextPolicy {
  build(input: ContextRequest): Promise<ModelContext>;
  compact(input: CompactionRequest): Promise<CompactedContext>;
}
```

Policy differenti:

-   `LeadContextPolicy`
-   `ExploreContextPolicy`
-   `BuilderContextPolicy`
-   `CriticContextPolicy`
-   `VerifierContextPolicy`
-   `CouncilContextPolicy`

## 4.3 Orchestrator

Responsabilità:

-   mission lifecycle;
-   decomposition;
-   dependency graph;
-   scheduling;
-   worker allocation;
-   escalation;
-   budgets;
-   pause/resume;
-   recovery;
-   policy di completamento.

## 4.4 Verification

Deve essere un dominio separato dall'implementation.

Ordine consigliato:

1.  deterministic checks;
2.  repository constraints;
3.  acceptance criteria;
4.  critic review;
5.  specialized checks;
6.  final completion policy.

## 4.5 Platform

Responsabilità:

-   protocollo pubblico;
-   SDK;
-   RPC;
-   extension API;
-   tracing;
-   telemetry;
-   replay;
-   eval harness.

------------------------------------------------------------------------

# 5. Mission come API primaria

L'API pubblica di alto livello deve essere mission-centric.

``` ts
const mission = await zelari.missions.create({
  objective: "Migra authentication a OAuth mantenendo compatibilità",
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

API minima:

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

`AgentHarness` rimane un'API importante per embedding avanzato, ma non
deve essere il concetto principale del prodotto.

------------------------------------------------------------------------

# 6. Mission state machine

Stati suggeriti:

``` text
CREATED
  ↓
ANALYZING
  ↓
PLANNED
  ↓
RUNNING
  ├── WAITING_APPROVAL
  ├── PAUSED
  ├── RECOVERING
  └── VERIFYING
          ├── REPAIRING → RUNNING
          ├── HOLD
          └── PASSED
```

Terminali:

-   `PASSED`
-   `FAILED`
-   `CANCELLED`
-   `HOLD`

`HOLD` è importante: budget esaurito o impossibilità di verificare non
devono essere trasformati falsamente in successo.

------------------------------------------------------------------------

# 7. Complexity Router

Prima di orchestrare, classificare:

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
TRIVIAL  → single agent
NORMAL   → agent + independent verifier
COMPLEX  → Kraken
HIGH-RISK → Kraken + specialist critics
AMBIGUOUS → Council/design → Kraken
EPIC     → Council + hierarchical Kraken Graph
```

Il router deve essere valutabile. Ogni decisione va registrata e
confrontata con outcome reali.

------------------------------------------------------------------------

# 8. Kraken 3

Kraken deve evolvere da "super-agent" a **mission scheduler agentico**.

Responsabilità:

-   decomporre;
-   creare DAG;
-   assegnare ruoli;
-   scegliere model tier;
-   allocare worktree;
-   monitorare progress;
-   riconoscere blocchi;
-   riplanificare;
-   escalare;
-   terminare worker inutili;
-   richiedere verifica.

Kraken non deve fare personalmente tutto il lavoro.

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

Priorità calcolata usando:

-   critical path;
-   dependency unlock value;
-   risk;
-   cost;
-   expected duration;
-   confidence;
-   workspace collision.

------------------------------------------------------------------------

# 9. Council 3

Council non deve essere obbligatoriamente una pipeline fissa.

Passare a **dynamic role assembly**.

Esempio:

``` text
Mission: race condition nel transaction engine

Ruoli:
✓ concurrency specialist
✓ repository explorer
✓ test strategist
✓ critic

Non necessari:
✗ product ideator
✗ documentation planner
```

Il Council deve rispondere a una domanda precisa:

> Quale decisione richiede pluralità di prospettive prima
> dell'esecuzione?

Usarlo per:

-   architecture;
-   ambiguous requirements;
-   high-risk migrations;
-   security boundaries;
-   alternative strategies.

Non usarlo automaticamente per task semplici.

------------------------------------------------------------------------

# 10. Role system

Separare `Role` da `AgentInstance`.

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

Vantaggi:

-   riuso;
-   eval per ruolo;
-   model routing;
-   sicurezza;
-   parallelismo;
-   comparazione A/B.

------------------------------------------------------------------------

# 11. Builder--Critic Gauntlet

Per output importanti:

``` text
Builder
  ↓
Candidate
  ↓
Fresh-context Critic
  ↓
Biggest gap
  ├── gap → Builder round N+1
  └── wins quality bar → verification
```

Regole:

1.  critic non eredita il reasoning del builder;
2.  critic riceve output reale e rubric;
3.  deve nominare il **singolo gap più importante**;
4.  il builder riceve il gap, non una riscrittura completa;
5.  round limit configurabile;
6.  deterministic gate resta autorità finale.

Quality bar può essere:

-   baseline corrente;
-   implementation di riferimento;
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

Ogni check produce:

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
        ↓
required evidence complete?
        ↓
   no → continue/hold
        ↓ yes
all hard gates pass?
        ↓
   no → repair/fail
        ↓ yes
soft confidence acceptable?
        ↓
   no → critic/escalate
        ↓ yes
      PASS
```

------------------------------------------------------------------------

# 13. Budget Scheduler

Budget come primitive first-class:

``` ts
type Budget = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxMinutes?: number;
  maxTurns?: number;
  maxParallelAgents?: number;
};
```

Strategia:

-   cheap/fast model per discovery semplice;
-   frontier reasoning per architecture;
-   coding-specialized model per implementation;
-   deterministic tool prima di LLM verification;
-   escalation solo su failure/low confidence.

Metriche:

-   cost/pass;
-   tokens/pass;
-   wall-clock/pass;
-   agent-minutes;
-   retry count;
-   wasted work;
-   critical-path efficiency.

------------------------------------------------------------------------

# 14. Speculative execution

Per decisioni ad alta incertezza e verificabili:

``` text
Strategy A ─┐
            ├─ deterministic comparison → winner
Strategy B ─┘
```

Usare quando:

-   alternative implementative sono economiche;
-   esiste quality bar oggettiva;
-   il costo di discussione supera il costo di prototipazione.

Non usare indiscriminatamente.

------------------------------------------------------------------------

# 15. Event model unificato

Ogni componente emette eventi immutabili.

Esempi:

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

Questo diventa il sistema nervoso per:

-   UI;
-   tracing;
-   replay;
-   telemetry;
-   extensions;
-   debugging;
-   eval.

------------------------------------------------------------------------

# 16. Observer & Intervention API

Observer:

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

Interventi:

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

Usi:

-   anti-loop;
-   cost guard;
-   security;
-   human steering;
-   policy enforcement;
-   experiment instrumentation.

------------------------------------------------------------------------

# 17. Anti-loop e no-progress detection

Segnali:

-   stesso tool + stessi args ripetuti;
-   edit revertiti ciclicamente;
-   identico errore dopo N tentativi;
-   nessuna variazione del diff;
-   test failure invariato;
-   context churn senza artifact;
-   repeated exploration su stessi file.

Azioni:

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

## 18.1 Fonti

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

Allocazione esplicita:

``` text
system/role       10%
mission state     10%
relevant code     45%
recent work       15%
memory             5%
verification      10%
reserve            5%
```

Percentuali dinamiche, non rigide.

## 18.3 Typed compaction

Non "riassumi la chat".

Produrre strutture:

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

Registrare hash della vista di contesto per riproducibilità ed eval.

------------------------------------------------------------------------

# 19. Memory 3

Separare:

1.  **ephemeral working memory**
2.  **mission memory**
3.  **project memory**
4.  **verified knowledge**
5.  **user/team policy**

Ogni memory item:

``` text
source
confidence
scope
created_at
last_verified_at
expires/invalidates
evidence
```

Regola:

> La memoria non verificata non deve trasformarsi silenziosamente in
> verità.

Supportare invalidazione quando il codice cambia.

------------------------------------------------------------------------

# 20. Workspace & worktree model

Primitive:

``` text
Workspace
WorkspaceSnapshot
Worktree
Checkpoint
Patch
Artifact
```

Policy:

-   explorer: read-only;
-   builder: scoped write;
-   critic: preferibilmente read-only;
-   verifier: read-only salvo fixture esplicite;
-   parallel builder: worktree isolati quando collision risk \>
    threshold.

Merge controllato e verificato.

------------------------------------------------------------------------

# 21. Permission & security model

Livelli:

``` text
read
workspace-write
external-network
credential-use
destructive
publish/deploy
full-access
```

Decisione basata su:

-   role;
-   mission policy;
-   tool;
-   target;
-   environment;
-   trust level.

Supportare:

-   allow;
-   deny;
-   ask;
-   allow-once;
-   allow-for-mission;
-   scoped allow.

Audit completo tramite event log.

------------------------------------------------------------------------

# 22. Tool Runtime

Tool contract uniforme:

``` ts
interface ZelariTool<I, O> {
  definition: ToolDefinition;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
```

Categorie:

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

Ogni tool deve dichiarare:

-   side effects;
-   permission class;
-   timeout;
-   idempotency;
-   concurrency safety;
-   output size policy.

------------------------------------------------------------------------

# 23. Provider Runtime

Provider adapter deve normalizzare:

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

Lo scheduler seleziona modelli per capability, non per hardcoded brand.

------------------------------------------------------------------------

# 24. Zelari Extension Protocol (ZEP)

Obiettivo: permettere ad altri ambienti di integrare Zelari senza
possederne il runtime.

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

Supportare progressivamente:

1.  in-process TypeScript SDK;
2.  stdio JSON-RPC;
3.  local socket;
4.  HTTP/WebSocket per deployment remoto.

## 24.3 Versioning

Protocol version:

``` text
zep/1
```

Capability negotiation obbligatoria.

------------------------------------------------------------------------

# 25. Integrazioni esterne

## 25.1 OpenCode

OpenCode può:

-   mostrare mission UI;
-   inviare workspace;
-   renderizzare events;
-   rispondere approvals;
-   mostrare diff/artifacts.

Non possiede Kraken o Mission state.

## 25.2 Claude Code

Possibili modalità:

-   bridge command;
-   MCP-facing integration;
-   worker adapter sperimentale;
-   import/export di skill compatibili.

## 25.3 Codex

Possibili modalità:

-   external worker;
-   CI/client integration;
-   worktree interoperability.

## 25.4 Grok Build

Possibili modalità:

-   skill compatibility;
-   worker bridge;
-   comparative eval.

Nessuna integrazione è necessaria al core.

------------------------------------------------------------------------

# 26. External worker adapters

Fase avanzata, opzionale.

``` ts
interface ExternalWorkerAdapter {
  capabilities(): WorkerCapabilities;
  start(task: WorkerTask): Promise<WorkerHandle>;
  steer(handle: WorkerHandle, input: string): Promise<void>;
  stop(handle: WorkerHandle): Promise<void>;
  events(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
}
```

Zelari può quindi orchestrare:

``` text
native Zelari agent
Claude worker
Codex worker
OpenCode worker
custom enterprise worker
```

ma conserva:

-   mission state;
-   graph;
-   verification;
-   budget;
-   completion authority.

------------------------------------------------------------------------

# 27. Flight Recorder

Ogni run importante deve essere ricostruibile.

Registrare:

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

Confronti:

``` text
single agent vs Kraken
Kraken vs Kraken Graph
fixed Council vs dynamic Council
context policy A vs B
model A vs B
critic off vs on
memory off vs on
```

Cambiare una variabile alla volta.

------------------------------------------------------------------------

# 29. Harness manifest

Fingerprint versionato di:

-   tools;
-   schemas;
-   prompts;
-   policies;
-   context engine;
-   roles;
-   verifier config;
-   provider settings;
-   orchestration version.

Ogni eval deve indicare l'harness fingerprint.

------------------------------------------------------------------------

# 30. Regression gate

Una release candidate non passa se:

-   correctness scende oltre threshold;
-   hard benchmark regredisce;
-   cost esplode senza beneficio;
-   latency degrada oltre budget;
-   safety invariant fallisce.

Supportare eccezioni documentate con rationale.

------------------------------------------------------------------------

# 31. Observability dashboard

Metriche mission:

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

Metriche agente:

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

CLI/TUI/Desktop devono derivare lo stato dall'event stream.

Esempio:

``` text
ZELARI MISSION — OAuth Migration

Overall              ███████░░░ 72%
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

Non mantenere stato UI duplicato se può essere derivato dal runtime.

------------------------------------------------------------------------

# 33. Artifact model

Artifact first-class:

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

Ogni artifact:

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

Checkpoint automatici:

-   prima di high-risk edit;
-   prima di merge;
-   prima di migration;
-   prima di destructive command;
-   dopo milestone verificata.

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

Standardizzare:

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

Serve per eval e recovery automatico.

------------------------------------------------------------------------

# 36. Package strategy

Evitare package explosion iniziale.

Target pragmatico:

``` text
@zelari/core
@zelari/orchestration
@zelari/protocol
@zelari/sdk
zelari-code
```

Possibile successiva estrazione:

``` text
@zelari/eval
@zelari/provider-*
@zelari/mcp
```

Regola: creare package solo quando esiste un confine API stabile e
utile.

------------------------------------------------------------------------

# 37. Dependency rules

``` text
protocol     → nessuna dipendenza runtime
core         → protocol
orchestration→ core + protocol
sdk          → protocol
cli          → sdk/orchestration
desktop      → sdk/protocol
extensions   → sdk/protocol
```

Vietare:

``` text
core → cli
core → desktop
core → OpenCode
core → Claude Code
core → Codex
orchestration → UI
```

Enforcement tramite lint/architecture tests.

------------------------------------------------------------------------

# 38. Migrazione dal codice 2.14

## Fase A --- Architectural excavation

Prima di modificare:

-   dependency graph reale;
-   import graph;
-   ownership dello state;
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

## Fase B --- Freeze public contracts

Definire ciò che deve rimanere compatibile.

Output:

`docs/architecture/compatibility-contract.md`

## Fase C --- Event spine

Introdurre event model senza cambiare comportamento.

Gate: stessi eval + stessi output.

## Fase D --- Observer/intervention

Estrarre policy dal loop.

Gate: agent loop regression-neutral.

## Fase E --- Context Engine

Separare run truth e model context.

Gate: qualità \>= baseline, token efficiency migliorata.

## Fase F --- Mission API

Mission diventa primitive pubblica.

CLI continua a funzionare tramite adapter.

## Fase G --- Orchestration consolidation

Kraken/Council usano lo stesso kernel/event/context system.

## Fase H --- Verification Engine

Unificare evidence e completion.

## Fase I --- Protocol/SDK

Rendere Zelari consumabile da client esterni.

## Fase J --- External extensions

VS Code/OpenCode/CI proof-of-concept.

------------------------------------------------------------------------

# 39. Roadmap proposta

## Milestone 0 --- Baseline & map

**Durata indicativa:** 1--2 settimane

Deliverable:

-   architecture map;
-   dependency graph;
-   benchmark baseline;
-   harness manifest;
-   top failure modes;
-   compatibility matrix.

Exit gate:

> Sappiamo misurare se Zelari 3 migliora o peggiora Zelari 2.14.

## Milestone 1 --- Runtime Spine

**Durata:** 2--4 settimane

Deliverable:

-   unified event model;
-   run identity;
-   cancellation;
-   observer API;
-   intervention API;
-   tracing.

Exit gate:

> CLI e Kraken funzionano senza regressioni rilevanti.

## Milestone 2 --- Context Engine

**Durata:** 3--5 settimane

Deliverable:

-   ContextPolicy;
-   typed compaction;
-   role contexts;
-   context fingerprint;
-   token budgets.

Exit gate:

> > = baseline correctness con minore context/token waste.

## Milestone 3 --- Mission Kernel

**Durata:** 3--5 settimane

Deliverable:

-   mission state machine;
-   public mission API;
-   pause/resume/steer;
-   artifacts;
-   checkpoints.

Exit gate:

> Una missione può essere eseguita headless senza dipendere dalla CLI.

## Milestone 4 --- Orchestration 3

**Durata:** 4--6 settimane

Deliverable:

-   Complexity Router;
-   Kraken scheduler;
-   dynamic Council;
-   Role/AgentInstance split;
-   budget scheduler;
-   graph recovery.

Exit gate:

> Kraken dimostra vantaggio misurabile su benchmark complessi.

## Milestone 5 --- Verification 3

**Durata:** 3--4 settimane

Deliverable:

-   evidence model;
-   builder/critic;
-   deterministic gates;
-   acceptance DSL;
-   completion policy.

Exit gate:

> Nessuna missione viene marcata PASS senza evidence richiesta.

## Milestone 6 --- Zelari Protocol & SDK

**Durata:** 3--5 settimane

Deliverable:

-   ZEP/1;
-   TypeScript SDK;
-   stdio RPC;
-   event streaming;
-   permission channel.

Exit gate:

> Un client minimale esterno può controllare una missione completa.

## Milestone 7 --- Ecosystem

**Durata:** iterativa

Deliverable:

-   VS Code prototype;
-   CI adapter;
-   OpenCode integration;
-   external worker experiments;
-   extension docs.

Exit gate:

> Almeno due client non-Zelari possono usare Zelari senza dipendenze
> interne.

------------------------------------------------------------------------

# 40. Sequenza prioritaria

Ordine raccomandato:

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

Non iniziare da UI o marketplace.

------------------------------------------------------------------------

# 41. Cosa NON fare

## 41.1 Non riscrivere tutto

Rischi:

-   regressioni;
-   perdita di edge case;
-   mesi senza valore utente;
-   impossibilità di A/B.

## 41.2 Non aumentare il numero di agenti come obiettivo

Più agenti ≠ migliore harness.

Ottimizzare:

``` text
quality / cost / latency
```

## 41.3 Non creare Council obbligatorio

Usarlo solo quando aggiunge valore.

## 41.4 Non dipendere da un harness esterno

Compatibilità sì; dipendenza no.

## 41.5 Non confondere telemetry con memory

Telemetry descrive ciò che è accaduto.

Memory influenza decisioni future.

## 41.6 Non permettere "PASS by narrative"

"Ho completato il task" non è evidence.

------------------------------------------------------------------------

# 42. KPI

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

La metrica più importante:

> **False PASS rate deve tendere a zero.**

------------------------------------------------------------------------

# 43. Release criteria per Zelari 3.0

Zelari 3.0 non dovrebbe essere dichiarato tale finché:

-   [ ] Mission API è stabile;
-   [ ] event model è stabile;
-   [ ] run truth è separato da context;
-   [ ] Kraken e Council usano il kernel condiviso;
-   [ ] verification evidence è first-class;
-   [ ] completion gate non dipende dalla narrativa del modello;
-   [ ] headless execution è completa;
-   [ ] SDK pubblico esiste;
-   [ ] ZEP/1 è versionato;
-   [ ] CLI è client del runtime, non proprietaria dello state;
-   [ ] Desktop è client del runtime;
-   [ ] eval regression gate è obbligatorio;
-   [ ] almeno un'integrazione esterna dimostra il protocollo;
-   [ ] nessun harness esterno è una dipendenza fondamentale;
-   [ ] migration guide da 2.x è disponibile.

------------------------------------------------------------------------

# 44. Compatibilità 2.x

Strategia:

-   deprecazioni graduali;
-   compatibility facade;
-   warning prima di rimozione;
-   codemod dove possibile;
-   documentazione "2.x → 3.x".

Mantenere temporaneamente:

``` text
AgentHarness legacy facade
existing CLI commands
existing config
existing skills
existing MCP config
```

con traduzione verso il nuovo kernel.

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

Run registrati rigiocabili contro componenti aggiornati.

## Chaos

Simulare:

-   provider timeout;
-   malformed tool output;
-   process crash;
-   permission denied;
-   worktree conflict;
-   test flakiness;
-   context overflow.

------------------------------------------------------------------------

# 46. Security

Threat model esplicito per:

-   prompt injection;
-   malicious repository;
-   poisoned MCP;
-   credential exfiltration;
-   destructive shell;
-   dependency confusion;
-   extension abuse;
-   memory poisoning.

Security invariants devono essere testabili.

------------------------------------------------------------------------

# 47. Extension trust model

Categorie:

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

Niente accesso implicito all'intero runtime.

------------------------------------------------------------------------

# 48. Configurazione

Gerarchia:

``` text
defaults
global user
project
mission
runtime override
```

Ogni valore deve poter indicare provenance per debugging.

------------------------------------------------------------------------

# 49. Developer experience

Comandi target:

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

Per modifiche al kernel richiedere:

-   architecture note;
-   tests;
-   eval delta;
-   benchmark cost delta;
-   backward compatibility note.

ADR per decisioni irreversibili.

Directory suggerita:

``` text
docs/
  architecture/
  adr/
  protocol/
  eval/
  migration/
```

------------------------------------------------------------------------

# 51. Gauntlet di sviluppo di Zelari 3

Ogni componente importante segue:

``` text
baseline
   ↓
builder implementation
   ↓
independent critic
   ↓
largest gap
   ↓
revision
   ↓
A/B eval
   ↓
regression gate
   ↓
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

Il critic deve confrontare contro una baseline concreta, non contro
impressioni.

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

Workstream indipendenti dove possibile, con contract-first development.

------------------------------------------------------------------------

# 53. Decisioni da validare prima di codificare

1.  Event store: JSONL, SQLite o dual?
2.  Mission persistence schema?
3.  ZEP transport iniziale?
4.  In-process API e RPC condividono gli stessi DTO?
5.  Context compaction deterministica o model-assisted?
6.  Council dinamico: rule-based, model-routed o ibrido?
7.  Budget scheduler: heuristic prima, learned dopo?
8.  Worktree isolation default per quali classi?
9.  Extension sandbox?
10. External workers inclusi in 3.0 o post-3.0?

------------------------------------------------------------------------

# 54. Decisioni consigliate

### Event persistence

SQLite per query + export JSONL per portability/replay.

### Protocol

TypeScript DTO condivisi + stdio JSON-RPC come primo transport esterno.

### Context

Ibrido: struttura deterministica, summarization model-assisted.

### Complexity Router

Heuristic + model classification, con override deterministico.

### Budget scheduler

Heuristic in 3.0; adaptive/learned solo dopo dataset sufficiente.

### External workers

Post-3.0 salvo proof-of-concept.

### Extension ecosystem

Protocollo in 3.0; marketplace successivamente.

------------------------------------------------------------------------

# 55. Rischi principali

## R1 --- Overengineering

Mitigazione: ogni nuovo layer deve dimostrare valore in eval.

## R2 --- Package explosion

Mitigazione: bounded contexts prima, package dopo.

## R3 --- Multi-agent cost explosion

Mitigazione: Complexity Router + budgets.

## R4 --- Context regressions

Mitigazione: fingerprint + replay + A/B.

## R5 --- False PASS

Mitigazione: deterministic evidence.

## R6 --- API freeze troppo precoce

Mitigazione: `experimental` namespace fino a stabilizzazione.

## R7 --- Extension attack surface

Mitigazione: permissions + sandbox + manifests.

## R8 --- Migrazione infinita

Mitigazione: milestone verticali utilizzabili.

------------------------------------------------------------------------

# 56. Definition of Done per ogni milestone

Una milestone è completa solo se:

-   codice merged;
-   tests verdi;
-   docs aggiornate;
-   eval eseguiti;
-   cost delta noto;
-   regression gate passato;
-   migration impact documentato;
-   observability disponibile;
-   rollback possibile.

------------------------------------------------------------------------

# 57. Primo sprint concreto

## Giorni 1--2

-   generare import/dependency graph;
-   mappare entry point;
-   mappare state ownership;
-   catalogare runtime loops.

## Giorni 3--4

-   mappare Kraken/Council/Mission execution;
-   mappare verification;
-   mappare context;
-   mappare headless/Desktop boundaries.

## Giorno 5

-   current-state architecture doc;
-   top 10 coupling problems;
-   target dependency rules.

## Settimana 2

-   baseline eval suite;
-   Flight Recorder minimale;
-   event envelope;
-   instrumentazione non invasiva.

Output sprint:

``` text
docs/architecture/current-state.md
docs/architecture/target-state.md
docs/architecture/dependency-rules.md
docs/adr/0001-event-spine.md
eval/baseline-3.0.json
```

------------------------------------------------------------------------

# 58. Secondo sprint

Implementare event spine senza cambiare semantica.

Target:

``` text
AgentHarness
Kraken
Council
Mission
Verification
```

emettono eventi coerenti.

Non introdurre ancora nuove feature agentiche.

Questo crea la base osservabile necessaria per tutte le modifiche
successive.

------------------------------------------------------------------------

# 59. Strategia di branch/release

Suggerimento:

``` text
main          → stabile
next          → Zelari 3 integration
feature/*     → workstream
```

Release:

``` text
2.15/2.16 → backport compatibili
3.0-alpha → runtime spine + mission API
3.0-beta  → orchestration + verification + SDK
3.0-rc    → migration + ecosystem proof
3.0       → contracts stabili
```

Evitare un lungo branch non integrato.

------------------------------------------------------------------------

# 60. North-star architecture

La forma finale:

``` text
                     ┌───────────────┐
                     │     USER      │
                     └───────┬───────┘
                             │
                       Any Zelari Client
                             │
                       ZEP / Zelari SDK
                             │
                     ┌───────▼────────┐
                     │    MISSION     │
                     └───────┬────────┘
                             │
                    Complexity Router
                             │
           ┌─────────────────┼──────────────────┐
           │                 │                  │
      Single Agent         Kraken            Council
                             │                  │
                             └────────┬─────────┘
                                      │
                                  Kraken DAG
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
              Explorer             Builder              Critic
                 │                    │                    │
                 └────────────────────┼────────────────────┘
                                      │
                               Verification
                                      │
                              ┌───────┴────────┐
                              │                │
                            FAIL              PASS
                              │                │
                         repair/replan    Mission Complete
```

Sotto tutto:

``` text
Zelari Kernel
├── Event Runtime
├── Context Engine
├── Provider Runtime
├── Tool Runtime
├── Permissions
├── Memory
├── Workspace
└── Flight Recorder
```

------------------------------------------------------------------------

# 61. Criterio strategico finale

Ogni nuova feature deve rispondere a una delle seguenti domande:

1.  Aumenta la probabilità che una missione sia corretta?
2.  Riduce il costo per missione corretta?
3.  Riduce il tempo per missione corretta?
4.  Aumenta l'osservabilità o la capacità di recovery?
5.  Migliora l'indipendenza o l'estensibilità di Zelari?

Se la risposta è "no" a tutte, probabilmente non appartiene al core.

------------------------------------------------------------------------

# 62. Conclusione

Zelari 3 deve essere un'evoluzione della base esistente, non una
sostituzione.

La priorità non è aggiungere più agenti. È costruire un **runtime
coerente, osservabile, verificabile e programmabile** nel quale agenti,
Kraken e Council siano strategie sopra le stesse primitive.

Il moat tecnico di Zelari deve concentrarsi su:

``` text
Mission orchestration
+ adaptive scheduling
+ role-specific context
+ independent criticism
+ deterministic verification
+ recovery
+ eval-driven evolution
```

Il moat strategico deve essere:

``` text
independent runtime
+ provider neutrality
+ public protocol
+ external integrations without dependency
```

La frase che sintetizza Zelari 3:

> **Zelari non deve semplicemente eseguire agenti. Deve prendere una
> missione software, organizzare il lavoro necessario, produrre evidenza
> verificabile e sapere quando il risultato è realmente completo.**

E la regola che protegge l'indipendenza del progetto:

> **Gli altri possono installare Zelari, invocare Zelari o lavorare per
> Zelari. Zelari non deve aver bisogno di loro per essere Zelari.**

---

# 63. Aggiornamento architetturale — Model Intelligence & Native Wire

## 63.1 Nuovo principio: provider neutrality without model homogenization

Zelari 3 deve restare provider-neutral senza ridurre tutti i modelli al minimo comune denominatore. Una API semantica comune deve essere compilata verso il comportamento nativo della famiglia di modello e del provider selezionato.

```text
Zelari semantic intent
  reasoning: HIGH
  latency: FAST
  tool mode: AGGRESSIVE
        │
        ▼
Model Intelligence Layer
        │
  ┌─────┼─────┐
  ▼     ▼     ▼
Claude GPT   Grok
  │     │     │
  ▼     ▼     ▼
native wire/native policy
```

## 63.2 Separare Provider, Model Family e Wire Policy

Il runtime non deve trattare `provider` e `model` come sinonimi. Introduciamo tre concetti distinti:

- **ProviderAdapter**: trasporto, autenticazione, streaming, errori, usage e primitive API.
- **ModelProfile**: capability, limiti, costo, latency class, punti di forza e risultati eval.
- **WirePolicy**: traduzione dell'intento Zelari nei parametri, tool dialect, reasoning controls, prompt conventions e altre semantiche native del modello.

## 63.3 ModelProfile

Schema concettuale:

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

I punteggi empirici devono provenire dagli eval Zelari e non essere confusi con capability dichiarate dal provider.

## 63.4 Capability Registry

Il registry deve distinguere:

1. capability dichiarata;
2. capability sintatticamente accettata;
3. capability behavioralmente verificata;
4. performance osservata negli eval.

Un HTTP 200 non costituisce prova che una capability sia stata applicata.

## 63.5 Fail closed sulle capability

Quando una missione richiede una proprietà che non può essere garantita:

```text
requested capability
       │
       ▼
verified support?
   ┌───┴───┐
  YES      NO
   │        │
execute   explicit downgrade / alternate model / reject
```

Zelari non deve dichiarare attivo un reasoning level, tool mode o altro controllo se il backend non può provarne l'applicazione.

## 63.6 Model-native execution

L'API comune deve esprimere intenzioni Zelari, per esempio:

```ts
{
  reasoning: "high",
  latencyPreference: "fast",
  toolStrategy: "aggressive",
  structuredOutput: true
}
```

La WirePolicy produce la configurazione appropriata per la famiglia concreta.

## 63.7 Model Scheduler capability-based

Kraken non dovrebbe richiedere necessariamente un model ID. Dovrebbe poter richiedere capability:

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

Il Model Scheduler sceglie il candidato usando:

- capability qualification;
- role eval score;
- costo;
- latency;
- disponibilità;
- context requirement;
- risk;
- budget residuo;
- provider health.

## 63.8 Model escalation

Il modello iniziale non deve necessariamente essere il più costoso. Strategia:

```text
cheap qualified model
       │
       ├─ success → verify
       │
       └─ low confidence/failure
                 ↓
            stronger model
                 │
                 └─ persistent failure → specialist/replan
```

L'escalation deve essere registrata nel Flight Recorder.

# 64. Model Probe

Aggiungere:

```text
zelari model probe <provider/model>
```

La probe deve testare, dove possibile:

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

Output indicativo:

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

Prima di marcare un modello come ufficialmente qualificato:

```text
Wire Probe
   ↓
Capability Probe
   ↓
Coding Micro-Evals
   ↓
Tool-Use Eval
   ↓
Context Eval
   ↓
Recovery Eval
   ↓
Kraken Worker Eval
   ↓
QUALIFIED
```

La suite genera un manifest versionato e firmato/hashato.

# 66. Model Drift Detection

Provider e modelli possono cambiare senza modifiche Zelari. Il runtime deve rilevare drift di:

- schema;
- capability;
- tool behavior;
- reasoning behavior;
- latency;
- error patterns;
- context behavior.

Drift significativo invalida la qualification precedente e può attivare regression eval mirati.

# 67. Zelari Doctor 3

`zelari doctor` deve diventare un diagnostico del runtime, non solo dell'installazione.

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

Deve distinguere warning, degraded e hard failure.

# 68. Nuovo Workstream WS10 — Model Intelligence & Native Wire

Deliverable:

- ModelProfile schema;
- Capability Registry;
- WirePolicy interface;
- native policy per principali famiglie;
- model probe;
- qualification suite;
- behavioral evidence;
- drift detection;
- model benchmark registry;
- provider health;
- capability-based model routing.

Exit gate:

> Zelari può selezionare e usare modelli differenti senza omogeneizzarne le capability e senza dichiarare supporto non verificato.

# 69. Architettura target aggiornata

```text
Clients / Extensions
        │
        ▼
ZEP + SDK
        │
        ▼
Mission Runtime
        │
        ▼
Complexity Router
        │
        ▼
Kraken / Council / Single Agent
        │
        ▼
Role + Capability Request
        │
        ▼
Model Scheduler
        │
        ├─────────────── Eval Registry
        ├─────────────── Budget Scheduler
        ├─────────────── Provider Health
        ▼
Model Intelligence Layer
        │
        ├── ModelProfile
        ├── Capability Registry
        └── WirePolicy
        │
        ▼
Provider Runtime
        │
   ┌────┼────┬────┐
   ▼    ▼    ▼    ▼
OpenAI Anthropic xAI Other
```

Il Model Intelligence Layer rimane interno a Zelari e indipendente da qualsiasi harness esterno.

# 70. Roadmap aggiornata

Inserire WS10 in parallelo dopo Runtime Spine e prima del completamento di Orchestration 3.

Ordine aggiornato:

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

Motivazione: lo scheduler Kraken deve poter essere progettato direttamente su capability reali invece di essere successivamente rifattorizzato da model-ID routing a capability routing.

# 71. Milestone aggiuntiva — Model Intelligence

**Durata indicativa:** 3–5 settimane, parzialmente parallela.

Deliverable:

- provider/model/wire separation;
- ModelProfile;
- WirePolicy;
- Capability Registry;
- `zelari model probe`;
- qualification manifest;
- primi eval per ruolo;
- fail-closed capability handling.

Exit gate:

> Almeno tre famiglie di modello possono eseguire la stessa intenzione semantica Zelari attraverso policy native verificate, con capability manifest riproducibile.

# 72. KPI aggiuntivi per Model Intelligence

- qualification pass rate;
- behavioral capability confidence;
- model drift incidents;
- role-specific pass rate;
- cost/pass per modello e ruolo;
- latency/pass;
- escalation rate;
- false capability declaration rate;
- scheduler regret: differenza tra modello scelto e miglior modello noto post-eval.

Target critico:

> **False capability declaration rate = 0 per capability hard-gated.**

# 73. Aggiornamento del moat tecnico

Il moat Zelari 3 diventa:

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

Il principio di indipendenza diventa:

> **Provider neutrality without model homogenization.**

Zelari deve poter usare il meglio di ogni modello senza trasformarsi in un wrapper di nessun provider o harness.

# 74. Formula finale aggiornata

Zelari 3 deve funzionare come un sistema a quattro livelli di intelligenza:

```text
MISSION INTELLIGENCE
Cosa deve essere ottenuto?
        ↓
ORCHESTRATION INTELLIGENCE
Come dividiamo, coordiniamo e verifichiamo il lavoro?
        ↓
MODEL INTELLIGENCE
Quale modello è più adatto a ciascun lavoro e come va pilotato nativamente?
        ↓
EXECUTION INTELLIGENCE
Quali tool, workspace, context e recovery servono per completarlo?
```

Il completamento rimane governato dall'evidenza:

```text
Model says done
      ≠
Mission complete

Candidate
   ↓
Evidence
   ↓
Independent criticism
   ↓
Deterministic verification
   ↓
PASS
```

La visione aggiornata può essere riassunta così:

> **Zelari è un runtime indipendente per missioni di software engineering che orchestra agenti e modelli in base alle loro capacità reali, li pilota secondo le loro semantiche native, verifica empiricamente ciò che producono e considera il lavoro completo soltanto quando esiste evidenza sufficiente per dimostrarlo.**
