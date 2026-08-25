# ZELARI_FRONTIER_RUNTIME_UPGRADE.md

# Zelari Code — Frontier Runtime Upgrade
## Observer Bus, Steering, Runtime Guards, Kraken Activity, Context Projection, Run Recorder & Evaluation

**Repository target:** `N-THEM-Studio/zelari-code`  
**Reference project studied:** `ApodexAI/FrontierAgent`  
**Target area:** `@zelari/core` + CLI/headless protocol + Zelari Desktop  
**Status:** Implementation specification  
**Baseline:** repository `main`, 25 agosto 2026

---

# 0. Executive summary

Questa specifica propone una serie di miglioramenti a Zelari Code ispirati ai pattern architetturali più interessanti osservati in FrontierAgent, senza introdurre una nuova modalità multi-agent concorrente a Kraken.

Il principio guida è:

> **Non creare un nuovo Agent Team. Migliorare il runtime che già alimenta Kraken, Council e Zelari.**

Zelari possiede già componenti molto avanzati:

- Kraken lead + tentacoli `explore`, `general`, `verify`;
- Kraken Graph DAG;
- parallelismo e worktree;
- strict verification;
- native criteria pack;
- durable state;
- checkpoint;
- semantic search;
- diagnostics;
- mission loop;
- headless NDJSON;
- Desktop Tauri.

Le lacune principali da colmare sono invece:

1. un **Observer / Intervention Runtime** uniforme;
2. **steering live** durante una run;
3. **anti-loop / no-progress guard** intelligenti;
4. una **Kraken Activity UI** che renda visibile ciò che fanno lead e tentacoli;
5. separazione strutturale tra **Run Record completo** e **Context Projection inviata al modello**;
6. tool-result spill recuperabile e deduplicato;
7. **typed compaction state**;
8. **ContextPolicy per tipo di agente**;
9. **Run Flight Recorder**;
10. un **evaluation harness A/B** per misurare realmente miglioramenti, costo e latenza.

La roadmap consigliata è:

```text
PHASE 1  Observer Runtime + Runtime Guards
PHASE 2  Bidirectional Headless Control + Steering
PHASE 3  Kraken Activity / Run Inspector
PHASE 4  Context Engine v2
PHASE 5  Run Flight Recorder
PHASE 6  Zelari Eval / A-B Harness
```

---

# 1. Cosa prendere da FrontierAgent e cosa NON prendere

## 1.1 Pattern utili

FrontierAgent ha alcuni concetti trasferibili molto bene a Zelari:

- observer callbacks sul loop;
- intervention esplicite;
- input asincrono durante una run;
- safe turn boundary;
- task/activity board live;
- full run record separato dal prompt effettivo;
- spill di tool output sovradimensionati;
- typed compaction;
- per-agent context projection;
- run artifacts;
- benchmark A/B.

Questi concetti migliorano l'affidabilità e l'osservabilità di un runtime agentico senza imporre una nuova architettura di orchestrazione.

## 1.2 Cosa non duplicare

Non aggiungere una quarta modalità chiamata, per esempio:

```text
agent-team
frontier
swarm
multi
```

Kraken ha già:

```text
Kraken Lead
├── Explore
├── General
├── Verify
└── Graph DAG
```

e Council ha già un workflow multi-agent separato.

Un ulteriore orchestratore aumenterebbe:

- complessità;
- duplicazione;
- costi di manutenzione;
- ambiguità UX;
- difficoltà di test.

La direzione corretta è quindi:

```text
               Shared Runtime Infrastructure
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
      Kraken            Council           Zelari
        │                                   │
     Graph/Tentacles                     Missions
```

---

# 2. Architettura target

## 2.1 Vista generale

```text
┌────────────────────────────────────────────────────────────┐
│                      Zelari Desktop                        │
│                                                            │
│ Chat       Kraken Activity      Run Inspector              │
│   │               │                  │                     │
│   └───────────────┼──────────────────┘                     │
│                   │                                        │
│        Steer / Queue / Cancel / Retry                      │
└───────────────────┬────────────────────────────────────────┘
                    │
                    │ ControlEvent
                    ▼
┌────────────────────────────────────────────────────────────┐
│                  Headless Control Plane                    │
│                                                            │
│ stdin  ← ControlEvent                                      │
│ stdout → BrainEvent                                        │
└───────────────────┬────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────┐
│                    Agent Runtime                           │
│                                                            │
│  Observer Bus                                              │
│  ├── SteeringObserver                                      │
│  ├── RepetitionGuard                                       │
│  ├── NoProgressGuard                                       │
│  ├── VerificationObserver                                  │
│  ├── DiagnosticsObserver                                   │
│  ├── TraceObserver                                         │
│  ├── MetricsObserver                                       │
│  └── ContextObserver                                       │
│                                                            │
│  AgentHarness                                              │
│       │                                                    │
│       ├──── Provider                                        │
│       ├──── Tools                                           │
│       └──── Context Engine                                  │
└───────────────┬───────────────────────────────┬────────────┘
                │                               │
                ▼                               ▼
         Kraken / Council                Run Flight Recorder
                │                               │
       ┌────────┼────────┐              .zelari/runs/<id>/
       │        │        │
    Explore  General   Verify
```

---

# 3. PHASE 1 — Observer / Intervention Runtime

## 3.1 Obiettivo

Creare una API comune che permetta a moduli indipendenti di:

- osservare il ciclo agentico;
- registrare telemetria;
- rilevare loop;
- bloccare o modificare un tool call;
- chiedere retry;
- iniettare istruzioni;
- fermare una run;
- trasformare un risultato prima che entri nel contesto.

Il runtime core deve rimanere il più possibile neutrale.

---

# 4. Nuovo modulo Observer

## 4.1 Posizione proposta

Se `AgentHarness` è in:

```text
packages/core/src/core/AgentHarness.ts
```

creare:

```text
packages/core/src/runtime/observers/
├── types.ts
├── ObserverBus.ts
├── composeObservers.ts
├── RuntimeGuardObserver.ts
├── SteeringObserver.ts
├── TraceObserver.ts
├── MetricsObserver.ts
└── index.ts
```

Se il repository usa una convenzione differente, mantenere la stessa separazione logica.

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

## 5.3 Callback principali

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

## 6.1 Tipo base

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

## 6.2 Regole

Un observer:

- non deve mutare silenziosamente lo state globale;
- deve restituire un risultato esplicito;
- non deve lanciare eccezioni per una decisione di policy normale;
- può essere `best-effort` oppure `fail-closed`.

---

# 7. Observer policy

## 7.1 Classificazione

```ts
export type ObserverFailureMode =
  | "ignore"
  | "warn"
  | "fail-closed";
```

Esempi:

```text
MetricsObserver          → ignore
TraceObserver            → warn
RepetitionGuard          → warn
AuthorizationObserver    → fail-closed
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
    // ordinamento stabile per priority
    // gestione errori secondo failureMode
    // raccolta interventions
  }
}
```

---

## 8.1 Priorità consigliate

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

# 9. Resolution delle intervention

Più observer possono rispondere allo stesso evento.

Priorità semantica:

```text
deny_tool
stop
retry
replace
inject
continue
```

Esempio:

```ts
function resolveInterventions(
  results: ObserverResult[]
): ObserverResult
```

Se due observer restituiscono `stop`, usare quello con priority più alta e registrare entrambi nel trace.

---

# 10. Integrazione in AgentHarness

Nel ciclo esistente:

```text
model
→ response
→ tool calls
→ tool execution
→ result
→ next turn
```

inserire:

```text
onRunStart

onModelAttempt
  ↓
provider
  ↓
onModelDelta*
  ↓
onModelResponse

for each tool:
  onToolCall
      ↓
  execute
      ↓
  onToolResult

onTurnEnd

...

onRunEnd
```

---

# 11. Backward compatibility

La prima patch deve funzionare con:

```ts
observers: []
```

senza modificare l'output corrente.

Il nuovo runtime deve essere opt-in internamente fino alla stabilizzazione.

Feature flag proposta:

```text
ZELARI_RUNTIME_OBSERVERS=1
```

Durante rollout iniziale:

```text
default = 0
```

Dopo test:

```text
default = 1
```

---

# 12. PHASE 1B — Runtime Guards

I guard devono essere observer, non condizioni sparse nel loop.

Creare:

```text
packages/core/src/runtime/guards/
├── RepetitionGuard.ts
├── NoProgressGuard.ts
├── FailureSignatureGuard.ts
├── DuplicateSearchGuard.ts
├── ToolLoopGuard.ts
├── ReasoningWatchdog.ts
└── types.ts
```

---

# 13. RepetitionGuard

## 13.1 Obiettivo

Rilevare tool call semanticamente identiche ripetute senza nuovo progresso.

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

## 13.2 Soglie

```ts
interface RepetitionGuardConfig {
  warnAfter: number; // default 2
  stopAfter: number; // default 5
}
```

---

## 13.3 Reazione

Alla seconda/terza ripetizione:

```text
WARN
```

Iniettare:

```text
The same tool call has produced no new progress multiple times.
Reassess the current hypothesis before repeating it again.
```

Al limite hard:

```text
STOP / recovery
```

---

# 14. FailureSignatureGuard

## 14.1 Problema

L'agente può modificare file diverse volte ma ottenere sempre:

```text
npm test
FAIL
```

con lo stesso errore.

Serve rilevare la firma del fallimento, non solo il comando.

---

## 14.2 Fingerprint

Per shell/test:

```ts
interface FailureSignature {
  commandHash: string;
  exitCode?: number;
  normalizedTailHash: string;
}
```

Normalizzare:

- timestamp;
- path temporanei;
- PID;
- UUID;
- linee di progress.

---

## 14.3 Esempio

```text
npm test
FAIL auth.spec.ts
Expected 200, received 401
```

ripetuto 3 volte:

```text
FailureSignatureGuard
→ inject
```

messaggio:

```text
The same failure signature has persisted across multiple attempts.
Do not repeat the previous edit strategy. Re-evaluate the root cause,
inspect upstream state, or delegate a fresh verification/exploration task.
```

---

# 15. NoProgressGuard

## 15.1 Segnali

Una run è potenzialmente stalled se per N turni:

- nessun file cambia;
- nessun task passa a completed;
- nessuna nuova discovery;
- stesso errore;
- stesso tool family;
- nessun nuovo graph node completato.

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

## 15.3 Soglie

```text
soft stall: 2 turni
hard stall: 5 turni
```

Per Zelari mission esiste già `ZELARI_MISSION_MAX_STALL`.

Il nuovo guard deve generalizzare il concetto al runtime Kraken normale.

---

# 16. DuplicateSearchGuard

Rilevare:

```text
grep A
grep A
grep A
```

oppure query semanticamente quasi identiche.

Per:

```text
grep_content
semantic_search
web_search
list_files
```

applicare fingerprint dedicati.

---

# 17. Reasoning / Provider watchdog

Zelari possiede già:

```text
ZELARI_PROVIDER_TIMEOUT_MS
```

Aggiungere telemetria e warning separati:

```text
model_call_started
model_first_token
model_call_finished
```

Metriche:

```text
time_to_first_token
generation_duration
stream_idle_duration
```

Feature env proposte:

```text
ZELARI_MODEL_FIRST_TOKEN_WARN_MS
ZELARI_MODEL_STREAM_IDLE_MS
```

Non interrompere automaticamente provider che supportano reasoning lungo senza evidenza di blocco reale.

---

# 18. Runtime Guard settings Desktop

In:

```text
Settings → Defaults → Runtime Guards
```

aggiungere:

```text
Runtime guardrails           ON

Repeated tool guard          ON
No-progress guard            ON
Repeated failure guard       ON
```

Nella prima versione usare preset e non esporre tutte le soglie.

---

# 19. Tooltip Runtime Guards

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

# 20. PHASE 2 — Live Steering

## 20.1 Obiettivo

Permettere all'utente di inviare un messaggio mentre Kraken sta lavorando.

Esempio:

```text
Non modificare il database.
Mantieni lo schema esistente.
```

Il messaggio:

- non cancella il tool corrente;
- non interrompe una chiamata provider in corso;
- entra al prossimo safe boundary;
- viene consegnato al Kraken Lead;
- non viene inviato retroattivamente ai tentacoli già in esecuzione;
- influenza nuove deleghe e la sintesi successiva.

---

# 21. Safe boundary semantics

Un `steer` può essere applicato:

```text
✓ dopo un tool result
✓ prima della successiva model call
✓ dopo fan-in tentacoli
✓ tra nodi mission
```

Non applicarlo:

```text
✗ durante un write_file
✗ nel mezzo di apply_diff
✗ nel mezzo di una risposta streaming
✗ tra tool_call e tool_result
```

---

# 22. Control plane headless

La Desktop oggi usa:

```text
zelari-code --headless
stdout → NDJSON BrainEvent
```

Per live steering il protocollo deve diventare bidirezionale:

```text
stdin  ← ControlEvent NDJSON
stdout → BrainEvent NDJSON
```

---

# 23. Nuovo ControlEvent

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

Semantica:

```text
run corrente finisce
→ follow-up diventa il prossimo user task
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

Aggiungere BrainEvent:

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

La Desktop non deve mostrare "steered" solo perché ha scritto su stdin.

Deve aspettare `control_accepted`.

---

# 25. Queue interna

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

Se arrivano:

```text
1. Non toccare il database
2. Anzi: puoi aggiungere una migration, ma non cancellare colonne
```

non compattare automaticamente.

Iniettare in ordine:

```text
Runtime user steering received during execution:

[1]
Non toccare il database

[2]
Anzi: puoi aggiungere una migration, ma non cancellare colonne

Later instructions may supersede earlier ones.
```

---

# 28. Late steer

Se la run ha già raggiunto l'ultimo boundary utile:

```text
steer
→ preserved
→ converted to follow-up
```

La Desktop deve mostrare:

```text
Queued as follow-up
```

---

# 29. Steering con Kraken Graph

Regola:

```text
Steer → Lead / Graph coordinator
```

Non interrompere direttamente:

```text
General #2 già in worktree
Explore #3 già running
```

Il Lead può:

- non lanciare nodi futuri;
- cambiare verifiche;
- aggiungere fix node;
- scartare risultati incompatibili;
- modificare la sintesi.

Feature futura opzionale:

```text
targetAgentId
```

Non implementare nella prima versione.

---

# 30. Desktop composer durante una run

Mockup:

```text
┌─────────────────────────────────────────────────────┐
│ Non modificare l'API pubblica...                    │
│                                                     │
│ [Steer current run] [Queue follow-up]      [Stop]   │
└─────────────────────────────────────────────────────┘
```

Default quando run attiva:

```text
Enter → Steer current run
Shift+Enter → newline
```

Oppure mantenere `Send` e mostrare un menu:

```text
Send as:
● Steer current run
○ Queue follow-up
```

---

# 31. Tooltip Steering

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

Nel composer/status:

```text
Queued: 2
```

Clic:

```text
Pending controls

STEER
1. Do not change public API

FOLLOW-UP
2. Add regression tests
```

Permettere:

```text
Remove
```

finché non è `control_applied`.

---

# 33. Tauri bridge

Il bridge Rust oggi gestisce il processo headless.

Per steering:

- mantenere handle stdin del child;
- mantenere child id per run;
- permettere un comando Tauri aggiuntivo.

Proposta:

```rust
#[tauri::command]
async fn send_control(
    state: State<'_, RunManager>,
    run_id: String,
    event: ControlEvent,
) -> Result<(), String>
```

---

# 34. RunManager lato Rust

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

Metodi:

```text
start
send_control
cancel
cleanup
```

---

# 35. Protocol version

Aggiungere handshake/event:

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

La Desktop deve fallbackare se usa una CLI vecchia:

```text
protocol v1
→ disabilita Steer
→ mostra tooltip:
  "Update Zelari CLI to use live steering."
```

---

# 36. PHASE 3 — Kraken Activity

## 36.1 Obiettivo

Rendere visibili:

- Kraken lead;
- tentacoli;
- Graph nodes;
- modello;
- stato;
- durata;
- scope;
- worktree;
- tool correnti;
- errori;
- verifica.

Non sostituire la chat.

---

# 37. Nuovi BrainEvent di activity

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

# 38. Activity store Desktop

Creare:

```text
apps/desktop/src/activity/
├── types.ts
├── activityReducer.ts
├── activitySelectors.ts
└── useRunActivity.ts
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

# 40. UI proposta

Nuovo pannello:

```text
KRAKEN ACTIVITY

LEAD
● Kraken
  model: strong-coding-model
  02:31

TENTACLES

⌕ Explore #1                     ✓ 0:18
   auth architecture
   model: fast-model

⌗ General #2                     ● 1:12
   src/auth/**
   model: coding-model
   worktree: kraken-82a1

⊙ Verify #3                      ◌ queued
   waiting for General #2
   model: review-model

GRAPH
3 / 6 complete
```

---

# 41. Agent symbols

Proposta:

```text
Lead      ◆
Explore   ⌕
General   ⌗
Verify    ⊙
Planner   ☑
Fix       ↻
```

Evitare di usare colore come unico indicatore.

---

# 42. Expanded agent details

Clic su `General #2`:

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

✓ read_file     src/auth/session.ts
✓ grep_content  refreshToken
✓ edit_file     src/auth/session.ts
● bash          npm test -- auth
```

---

# 43. Tool details

Clic tool:

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

Il pannello non deve caricare automaticamente output enormi.

---

# 44. Kraken Graph UI

Se Graph attivo:

```text
Graph

✓ inspect-auth
├─ ✓ api-change
├─ ● frontend-change
└─ ◌ verify
```

Mostrare dipendenze senza richiedere una libreria graph complessa nella prima versione.

Prima versione:

```text
indented dependency list
```

Fase futura:

```text
visual DAG
```

---

# 45. Activity tooltip

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

# 46. PHASE 4 — Context Engine v2

## 46.1 Principio

Il record storico completo e il contesto inviato al provider devono essere oggetti differenti.

```text
RunRecord
    │
    ▼
ContextProjector
    │
    ▼
ProjectedContext
    │
    ▼
Provider
```

Mai:

```text
truncate/mutate original transcript
```

---

# 47. Nuovi moduli

```text
packages/core/src/context/
├── RunRecord.ts
├── RunRecordStore.ts
├── ContextProjector.ts
├── ContextPolicy.ts
├── ToolResultSpill.ts
├── CompactionState.ts
├── renderCompaction.ts
├── tokenBudget.ts
└── index.ts
```

---

# 48. RunRecord

```ts
export interface RunRecord {
  runId: string;
  events: RunRecordEvent[];
}
```

Eventi:

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

# 49. Regola di integrità

Il RunRecord deve mantenere:

- contenuto completo;
- tool output completo o pointer lossless;
- ordine;
- parent/child agent;
- run id;
- turn id;
- tool call id;
- modello;
- timestamp.

La projection può essere lossy.

Il record non deve esserlo.

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

Explore non dovrebbe ricevere transcript completi di altri tentacoli.

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

Verify deve ricevere principalmente:

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

## 54.1 Obiettivo

Quando un tool produce output enorme:

```text
full result
→ spill store
→ short preview + recovery pointer
```

---

# 55. Spill directory

Proposta:

```text
.zelari/runs/<run-id>/spill/
```

Ma il modello non dovrebbe poterla modificare.

Se la sandbox Zelari permette policy di accesso:

```text
READ  ✓
WRITE ✗
```

Se ciò non è tecnicamente possibile in tutte le modalità, almeno:

- non includere la directory nei write roots;
- bloccare `write_file/edit_file` verso spill;
- bloccare redirect shell se già esiste una authorization layer.

---

# 56. Content-addressed spill

Nome:

```ts
sha256(toolName + "\0" + fullBody).slice(0, 16)
```

Path:

```text
spill/bash-4a81f9a2c19f0b33.txt
```

Se già esiste:

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

Il messaggio al modello:

```text
[Tool output truncated]

Preview:
...

Full output:
.zelari/runs/<run-id>/spill/bash-4a81f9a2c19f0b33.txt

Use read_file only if the omitted content is necessary.
```

Il pointer deve essere conteggiato nel cap totale.

---

# 59. Aggregate tool-result budget

Non limitare solo ciascun risultato.

Serve un budget per turno.

Esempio:

```text
max single tool result inline: 12k chars
max all tool results in turn: 32k chars
```

Se 6 tool paralleli producono 10k ciascuno:

```text
60k total
→ spill / reduce
```

---

# 60. Config proposta

```text
ZELARI_TOOL_RESULT_INLINE_CHARS=12000
ZELARI_TOOL_RESULT_TURN_CHARS=32000
ZELARI_TOOL_RESULT_SPILL=1
```

Non esporli subito nella Desktop normale.

Metterli eventualmente sotto:

```text
Advanced
```

---

# 61. Truncation strategy

Non ottimizzare prematuramente `head` vs `head+tail`.

Implementazione iniziale consigliata:

```text
ranked results
→ head

sequential logs
→ head + tail
```

ma dietro policy configurabile.

Importante:

- spill completo sempre recuperabile;
- aggregate budget;
- pointer nel cap;
- content hash;
- metriche di recovery read.

---

# 62. Typed CompactionState

Non salvare solo una summary prose.

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

Il modello vede markdown.

Il runtime conserva JSON tipizzato.

---

# 65. Compaction storage

```text
.zelari/runs/<run-id>/compactions/
├── c001.json
├── c002.json
└── latest.json
```

---

# 66. Durable state vs Run compaction

Non fondere:

```text
.zelari/state/
```

con:

```text
.zelari/runs/<run>/compactions/
```

Semantica:

```text
durable state
→ conoscenza verificata cross-run

compaction
→ compressione della run corrente
```

---

# 67. PHASE 5 — Run Flight Recorder

## 67.1 Obiettivo

Ogni run deve essere ispezionabile e riproducibile abbastanza da:

- fare debug;
- confrontare modelli;
- capire costi;
- capire loop;
- capire routing;
- visualizzare tentacoli;
- costruire benchmark.

---

# 68. Layout

```text
.zelari/
└── runs/
    └── <run-id>/
        ├── manifest.json
        ├── events.jsonl
        ├── trace.jsonl
        ├── metrics.json
        ├── verification.json
        ├── graph.json
        ├── controls.jsonl
        │
        ├── agents/
        │   ├── lead.jsonl
        │   ├── explore-1.jsonl
        │   ├── general-2.jsonl
        │   └── verify-3.jsonl
        │
        ├── compactions/
        │   └── ...
        │
        └── spill/
            └── ...
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

Non salvare:

- API keys;
- OAuth token;
- password SSH;
- secrets.

---

# 70. trace.jsonl

Eventi completi:

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

# 72. Run Inspector Desktop

Aggiungere:

```text
Run details
```

Sezioni:

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

Esempio:

```text
⚠ Repeated failure detected
npm test returned the same auth failure 3 times.
Kraken was instructed to reassess its hypothesis.
```

---

# 76. Tooltip Run Inspector

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

Non lasciare `.zelari/runs` crescere senza limiti.

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

Mai eliminare:

```text
active run
```

---

# 78. Gitignore

Assicurarsi che:

```text
.zelari/runs/
```

sia gitignored di default.

---

# 79. PHASE 6 — Zelari Eval

## 79.1 Obiettivo

Avere un harness riproducibile per rispondere a domande come:

```text
Il model routing fa risparmiare costo senza peggiorare pass-rate?

Il RepetitionGuard riduce i tool loop?

Lo spill riduce peak prompt?

Verify con modello piccolo regge?

Graph planner veloce peggiora la qualità del DAG?
```

---

# 80. Struttura

```text
packages/eval/
oppure
tools/eval/
```

Proposta:

```text
tools/eval/
├── runner.ts
├── suites/
├── scorers/
├── reporters/
└── experiments/
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

# 83. Esperimento model routing

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

# 84. Metriche minime

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

# 85. Risultato tabellare

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

# 86. Riproducibilità

Ogni result deve salvare:

```text
git commit
CLI version
provider
model ids
env diff
seed se applicabile
fixture hash
timestamp
```

---

# 87. Guard A/B

Esperimento:

```text
A = runtime guards OFF
B = runtime guards ON
```

Misurare:

```text
tool calls
stalled runs
same failure repetitions
duration
pass rate
```

---

# 88. Context A/B

Esperimento:

```text
A = current context behavior
B = Context Engine v2
```

Misurare:

```text
peak prompt tokens
compactions
recovery reads
duration
score/pass
```

---

# 89. Nuovi BrainEvent — elenco consolidato

Aggiungere progressivamente:

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

# 94. Desktop settings proposte

## Settings → Defaults

```text
Runtime Guards
  Runtime guardrails        ON
  Repeated tool guard       ON
  No-progress guard         ON
  Repeated failure guard    ON
```

## Settings → Advanced

```text
Runtime

  Live steering             ON
  Run flight recorder       ON

Context

  Context Engine v2         ON
  Tool-result spill         ON
```

Durante rollout, alcune opzioni possono essere marcate:

```text
Experimental
```

---

# 95. Tooltip Live steering

```text
Allows new instructions to be sent while an agent is working. They are
queued and applied at a safe turn boundary without interrupting an active
tool call or model request.
```

---

# 96. Tooltip Run flight recorder

```text
Stores structured events, metrics, agent activity, verification data and
context diagnostics for each run under .zelari/runs. Secrets are never
written to the recorder.
```

---

# 97. Tooltip Context Engine v2

```text
Separates the complete run record from the smaller context sent to the model.
This allows long tasks to retain recoverable evidence without keeping every
tool result in every model request.
```

---

# 98. Tooltip Tool-result spill

```text
Stores oversized tool outputs outside the active prompt and gives the agent
a short preview plus a recovery path. The complete output remains available
when it is actually needed.
```

---

# 99. Security considerations

## 99.1 Secrets

Il recorder deve redigere:

```text
Authorization headers
API keys
OAuth tokens
SSH passwords
secret env vars
```

Creare una funzione centralizzata:

```ts
redactRuntimePayload()
```

Non affidarsi a singoli writer.

---

# 100. Tool result safety

Spill può contenere secrets stampati da shell.

Quindi:

- directory locale non world-readable quando possibile;
- non sincronizzare;
- non includere automaticamente nei report;
- retention configurabile.

---

# 101. Control injection safety

`steer` è un nuovo user message e deve essere trattato come user input.

Non deve:

- bypassare Plan mode;
- bypassare folder trust;
- bypassare tool permissions;
- bypassare Strict gate.

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

Un failure del recorder non deve bloccare normalmente la run.

Un failure dell'authorization layer sì.

---

# 103. Cancellation semantics

Cancellation deve essere cooperativa.

Ordine:

```text
1. mark cancellation requested
2. stop scheduling new tools/tentacles
3. abort provider request if AbortController supportato
4. cancel pending graph nodes
5. allow cleanup hooks
6. emit run_cancelled
7. persist run state
```

---

# 104. Kraken tentacle cancellation

Per un tentacolo:

```text
running shell
→ AbortSignal se supportato
→ grace period
→ existing Kraken cancel grace logic
```

Riutilizzare:

```text
ZELARI_KRAKEN_CANCEL_GRACE_MS
```

non creare un secondo timeout equivalente.

---

# 105. Integration con Strict Gate

I Runtime Guards non devono dichiarare `done`.

Pipeline:

```text
Agent output
    ↓
Runtime Guards
    ↓
Verification
    ↓
Strict Gate
    ↓
Completed
```

Un observer può impedire continuation patologica, ma non sostituire verifica.

---

# 106. Integration con Native Criteria Pack

`Native Criteria Pack` deve emettere eventi:

```text
verification_check_started
verification_check_completed
```

e questi devono finire nel Run Recorder.

---

# 107. Integration con Advisory verifier

Advisory verifier resta:

```text
optional LLM judge
```

Non usare Advisory verifier come RepetitionGuard.

Sono responsabilità diverse.

---

# 108. Integration con Kraken Model Routing

La nuova Activity UI deve mostrare:

```text
actual resolved model
```

non semplicemente la preferenza Settings.

Esempio:

```text
Explore configured: Inherit
Resolved runtime model: fast-model
```

L'evento `agent_spawned` deve contenere il model realmente risolto.

---

# 109. Integration con Kraken Graph

Il planner deve emettere:

```text
agent_spawned role=planner
```

Graph state deve essere registrato:

```text
graph.json
```

e aggiornato atomicamente.

---

# 110. Integration con `.zelari/radio`

Non eliminare radio nella prima implementazione.

Possibili ruoli:

```text
radio
→ comunicazione tentacoli

Observer Bus
→ lifecycle/intervention/runtime telemetry
```

In futuro alcuni radio event possono essere normalizzati come runtime events, ma evitare un refactor simultaneo.

---

# 111. Integration con Durable State

Solo state verificato deve finire in:

```text
.zelari/state/
```

Il RunRecord può contenere ipotesi fallite.

Non promuovere automaticamente tutto.

---

# 112. Integration con `/compact`

`/compact` deve diventare:

```text
typed CompactionState
```

ma può continuare a mostrare all'utente una summary Markdown.

Backward compatibility:

```text
old session prose compact
→ supported
new sessions
→ typed state
```

---

# 113. Suggested file map — Core

Possibili nuovi file:

```text
packages/core/src/runtime/
├── observers/
│   ├── types.ts
│   ├── ObserverBus.ts
│   ├── SteeringObserver.ts
│   ├── TraceObserver.ts
│   └── MetricsObserver.ts
│
├── guards/
│   ├── RepetitionGuard.ts
│   ├── FailureSignatureGuard.ts
│   ├── NoProgressGuard.ts
│   └── DuplicateSearchGuard.ts
│
├── controls/
│   ├── types.ts
│   └── RuntimeControlQueue.ts
│
└── recorder/
    ├── RunRecorder.ts
    ├── Redactor.ts
    └── retention.ts
```

---

# 114. Suggested file map — Context

```text
packages/core/src/context/
├── ContextPolicy.ts
├── ContextProjector.ts
├── RunRecord.ts
├── RunRecordStore.ts
├── ToolResultSpill.ts
├── CompactionState.ts
├── renderCompaction.ts
└── tokenBudget.ts
```

---

# 115. Suggested file map — CLI/headless

Individuare i file attuali che:

- parsano `--headless`;
- stampano BrainEvent;
- gestiscono AgentHarness.

Aggiungere concettualmente:

```text
src/cli/headless/
├── controlReader.ts
├── protocol.ts
└── controlBridge.ts
```

Se l'headless è oggi tutto in un singolo file, effettuare prima una piccola estrazione senza modificarne il comportamento.

---

# 116. Suggested file map — Desktop

```text
apps/desktop/src/
├── activity/
│   ├── activityReducer.ts
│   ├── activitySelectors.ts
│   └── types.ts
│
├── components/
│   ├── KrakenActivity.tsx
│   ├── RunInspector.tsx
│   ├── RuntimeControls.tsx
│   └── RuntimeWarningCard.tsx
│
└── runtime/
    ├── controlClient.ts
    └── protocolCapabilities.ts
```

Tauri:

```text
apps/desktop/src-tauri/src/
├── run_manager.rs
├── control.rs
└── ...
```

Se il progetto preferisce mantenere tutto in `lib.rs`, iniziare lì ma estrarre `RunManager` appena la feature è stabile.

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

Casi:

```text
continue + continue → continue

continue + retry → retry

retry + stop → stop

observer throw + ignore → continue

observer throw + fail-closed → stop/error
```

---

# 119. Steering tests

```text
steer during tool
→ not injected mid-tool
→ applied at next boundary

2 steers
→ preserved order

steer after last useful boundary
→ follow-up

cancel
→ no new tool scheduled
```

---

# 120. Kraken Graph steering test

```text
General A running
General B running
user steer
→ A/B finish or cancel only through existing policies
→ steer delivered to lead
→ future nodes see updated instruction
```

---

# 121. Runtime Guard tests

### Repetition

```text
same tool x2
→ warning

same tool x5
→ hard intervention
```

### Failure

```text
same normalized test failure x3
→ warning/inject
```

### Progress

```text
new completed task
→ reset stall count
```

---

# 122. Context tests

## Record/projection separation

```text
full tool output = 100k chars

RunRecord
→ contains pointer/full retained body

ProjectedContext
→ <= configured cap
```

---

# 123. Spill tests

```text
same body twice
→ one spill file

different body
→ different hash

empty body
→ no spill

path cannot be written by file tool
```

---

# 124. Compaction tests

```text
serialize → parse
```

deve essere lossless per campi tipizzati.

Non fare test basati su regex Markdown come source of truth.

---

# 125. Desktop tests

```text
Activity receives agent_spawned
→ row appears

agent_status completed
→ state changes

control_accepted
→ queue state accepted

control_applied
→ queued badge removed

old CLI protocol
→ steering disabled
```

---

# 126. E2E headless test

Spawn:

```text
zelari-code --headless --output json
```

scrivere stdin:

```json
{"type":"steer","id":"s1","text":"Do not edit files","ts":0}
```

attendere:

```text
control_accepted
control_applied
```

---

# 127. Flight Recorder E2E

Run completa:

```text
manifest exists
events exists
metrics exists
no API key in any file
```

---

# 128. Acceptance criteria — Phase 1

- [ ] `ObserverBus` esiste.
- [ ] AgentHarness emette lifecycle callbacks.
- [ ] Observer error policies sono testate.
- [ ] RepetitionGuard funziona.
- [ ] FailureSignatureGuard funziona.
- [ ] NoProgressGuard funziona.
- [ ] Runtime warnings sono BrainEvent.
- [ ] Nessun cambiamento comportamentale con observers disabilitati.
- [ ] Existing unit tests restano verdi.

---

# 129. Acceptance criteria — Phase 2

- [ ] Headless protocol è bidirezionale.
- [ ] `protocol_info` espone capability.
- [ ] Desktop può inviare `steer`.
- [ ] `steer` viene applicato solo a safe boundary.
- [ ] Tool in-flight non viene spezzato.
- [ ] Multiple steer restano FIFO.
- [ ] Follow-up queue funziona.
- [ ] Cancel è cooperativo.
- [ ] Old CLI fallback è gestito.

---

# 130. Acceptance criteria — Phase 3

- [ ] Lead visibile in Kraken Activity.
- [ ] Explore/General/Verify visibili.
- [ ] Modello reale visibile.
- [ ] Durata visibile.
- [ ] Current tool visibile.
- [ ] Worktree visibile se presente.
- [ ] Graph node visibile.
- [ ] Tool details espandibili.
- [ ] UI non rallenta con centinaia di eventi.

---

# 131. Acceptance criteria — Phase 4

- [ ] RunRecord e ProjectedContext sono separati.
- [ ] Output tool grandi sono spillabili.
- [ ] Spill content-addressed.
- [ ] Per-turn aggregate budget applicato.
- [ ] Typed CompactionState implementato.
- [ ] ContextPolicy per role.
- [ ] Durable state resta separato.
- [ ] Existing provider prompt cache non viene inutilmente destabilizzata.

---

# 132. Acceptance criteria — Phase 5

- [ ] `.zelari/runs/<id>` creato.
- [ ] manifest/trace/metrics salvati.
- [ ] agent trajectories disponibili.
- [ ] secrets redatti.
- [ ] retention implementata.
- [ ] Desktop Run Inspector legge i dati.
- [ ] active run non viene cancellata dal cleanup.

---

# 133. Acceptance criteria — Phase 6

- [ ] Eval runner supporta almeno due arms.
- [ ] Environment per arm isolato.
- [ ] Pass/fail scorer disponibile.
- [ ] Token/tool/duration metrics.
- [ ] Run metadata riproducibile.
- [ ] Model-routing A/B eseguibile.
- [ ] Runtime-guards A/B eseguibile.
- [ ] Context A/B eseguibile.

---

# 134. Rollout consigliato

## Release A — Runtime Observability

Feature:

```text
ObserverBus
TraceObserver
MetricsObserver
runtime_warning
```

Nessuna intervention automatica.

---

## Release B — Runtime Guards

Attivare:

```text
RepetitionGuard
FailureSignatureGuard
NoProgressGuard
```

inizialmente:

```text
warn-only
```

Poi hard stop solo per loop chiari.

---

## Release C — Headless Protocol v2

Aggiungere:

```text
stdin ControlEvent
protocol_info
control acknowledgements
```

Senza UI avanzata.

---

## Release D — Desktop Steering

Aggiungere:

```text
Steer
Queue follow-up
Stop
Queued badge
```

---

## Release E — Kraken Activity

Aggiungere:

```text
agent events
activity panel
model routing visualization
```

---

## Release F — Context Engine v2

Dietro:

```text
ZELARI_CONTEXT_V2=1
```

A/B prima del default.

---

## Release G — Flight Recorder + Eval

Stabilizzare metriche e benchmark.

---

# 135. Feature flags consigliate

```text
ZELARI_RUNTIME_OBSERVERS=1
ZELARI_RUNTIME_GUARDS=1

ZELARI_HEADLESS_CONTROL=1
ZELARI_LIVE_STEERING=1

ZELARI_RUN_RECORD=1

ZELARI_CONTEXT_V2=1
ZELARI_TOOL_RESULT_SPILL=1
```

Non mantenere feature flags per sempre.

Dopo stabilizzazione:

- rimuovere flag superflui;
- lasciare kill switch per feature ad alto impatto.

---

# 136. Default suggeriti a maturità

```text
Observer runtime          ON
Runtime guards            ON
Live steering             ON Desktop
Flight recorder           ON
Context v2                ON
Tool spill                ON
```

---

# 137. Priorità pratica

## P0

Implementare subito:

```text
ObserverBus
Runtime Warning events
RepetitionGuard
FailureSignatureGuard
NoProgressGuard
```

Perché:

- impatto alto;
- rischio architetturale controllabile;
- abilita le fasi successive.

---

## P1

Poi:

```text
Headless Control v2
Steering
Kraken Activity
```

Queste danno il salto UX maggiore alla Desktop.

---

## P1 / P2

Poi:

```text
RunRecord
ContextProjection
Tool Spill
Typed Compaction
```

Hanno impatto enorme sulle run lunghe, ma toccano il prompt lifecycle e richiedono A/B.

---

## P2

Infine:

```text
Flight Recorder completo
Eval harness
```

Il recorder minimo può arrivare prima; l'eval completo dopo.

---

# 138. Decisioni architetturali da formalizzare come ADR

Creare ADR per:

```text
Observer intervention contract
Headless protocol v2
RunRecord vs ContextProjection
Tool spill storage policy
Runtime run-artifact schema
```

Esempio:

```text
docs/decisions/00xx-runtime-observer-bus.md
docs/decisions/00xx-headless-control-protocol.md
docs/decisions/00xx-run-record-context-projection.md
```

---

# 139. Non-goals

Questa specifica NON propone:

- nuovo sistema Agent Team;
- sostituzione Kraken Graph;
- sostituzione Council;
- sostituzione `.zelari/state`;
- cross-provider routing dinamico;
- remote distributed agent scheduler;
- cancellazione violenta di processi come default;
- log completo del chain-of-thought;
- storage di credenziali nel run recorder.

---

# 140. Privacy / reasoning trace

Il runtime recorder deve registrare:

```text
tool calls
tool results
assistant messages
system/runtime events
metrics
verification
```

Non deve essere progettato per salvare chain-of-thought privata del provider.

Se un provider restituisce campi reasoning separati:

- trattarli secondo le policy/provider contract;
- non renderli automaticamente in UI;
- non basare il debugger su reasoning nascosto.

---

# 141. Performance requirements

Observer:

```text
overhead sync target < 2 ms/event
```

Trace writer:

```text
buffered / async
```

Desktop Activity:

```text
virtualize / cap rendered events
```

Non fare rerender completo della chat per ogni model delta.

---

# 142. Event batching

Per streaming:

Non inviare necessariamente un evento Tauri per ogni token.

Batch:

```text
25–50 ms
```

o dimensione:

```text
N chars
```

La Activity UI non ha bisogno di model token delta.

---

# 143. Atomic writes

Per:

```text
manifest.json
metrics.json
graph.json
compactions/latest.json
```

usare:

```text
write tmp
fsync se necessario
rename atomico
```

JSONL può essere append-only.

---

# 144. Crash recovery

Se Zelari crasha:

```text
manifest.status = running
```

al prossimo avvio:

```text
detect stale
→ mark interrupted
```

Non dichiarare `failed` automaticamente se non noto.

Status:

```text
interrupted
```

---

# 145. Session vs Run

Definire:

```text
Session
→ conversazione persistente multi-turn

Run
→ singola esecuzione di un task/user turn
```

Quindi:

```text
sessionId
runId
```

devono essere distinti.

---

# 146. Follow-up

Un follow-up:

```text
stessa session
nuovo runId
```

Steer:

```text
stesso runId
```

---

# 147. Tentacle run identity

Ogni tentacolo:

```text
same root runId
unique agentId
```

Non creare un root run separato.

---

# 148. Metrics aggregation

Root metrics:

```text
sum tentacle tokens
sum model calls
sum tools
```

ma mantenere breakdown:

```text
lead
explore
general
verify
planner
```

---

# 149. Cost model

Se il provider espone prezzo o esiste catalogo locale:

```text
estimatedCost
```

Altrimenti:

```text
null
```

Non inventare costi.

---

# 150. Final target experience

Utente avvia:

```text
Kraken + Build
```

Prompt:

```text
Refactorizza il sistema auth mantenendo compatibilità.
Verifica con test.
```

Desktop:

```text
KRAKEN ACTIVITY

◆ Lead           ●
⌕ Explore #1     ✓
⌗ General #2     ●
⊙ Verify #3      queued
```

L'utente scrive:

```text
Non cambiare la struttura del database.
```

Desktop:

```text
Steer queued
```

Kraken termina il tool corrente.

Runtime:

```text
control_applied
```

Lead riceve l'istruzione.

General termina il suo task.

FailureSignatureGuard vede:

```text
stesso auth test fallito 3 volte
```

inietta:

```text
Reassess root cause.
```

Kraken cambia strategia.

Un output test da 90k viene:

```text
spill
```

e solo preview entra nel prompt.

Verify passa.

Strict Gate riceve evidenza.

Run termina.

Run Inspector mostra:

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

Questo è il comportamento target.

---

# 151. Roadmap finale sintetica

```text
                    TODAY
                      │
                      ▼
             Kraken Model Routing
                      │
                      ▼
             Observer Runtime
                      │
             ┌────────┴─────────┐
             │                  │
             ▼                  ▼
        Runtime Guards     Flight events
             │                  │
             └────────┬─────────┘
                      ▼
              Headless Protocol v2
                      │
             ┌────────┴─────────┐
             ▼                  ▼
          Steering        Kraken Activity
             │                  │
             └────────┬─────────┘
                      ▼
                Context Engine v2
                      │
          ┌───────────┼────────────┐
          ▼           ▼            ▼
       RunRecord   Tool Spill   Typed Compact
          │
          ▼
      Flight Recorder
          │
          ▼
        Zelari Eval
```

---

# 152. Conclusione

La parte più utile di FrontierAgent per Zelari Code non è il suo workflow multi-agent.

La vera opportunità è costruire un runtime più:

- osservabile;
- steerable;
- resistente ai loop;
- misurabile;
- efficiente nel contesto;
- trasparente nella Desktop.

L'ordine più sicuro è:

```text
Observer Bus
→ Runtime Guards
→ Steering
→ Activity
→ Context Engine
→ Flight Recorder
→ Evaluation
```

Questa sequenza permette a Zelari di mantenere Kraken come elemento distintivo, rendendolo però molto più controllabile e verificabile nelle run lunghe e multi-agent.

---

# 153. Riferimenti tecnici

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

# 154. Implementation checklist master

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
