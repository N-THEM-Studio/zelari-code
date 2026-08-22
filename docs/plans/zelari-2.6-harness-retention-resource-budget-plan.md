# Zelari 2.5+ — Piano integrato di implementazione
## Harness Retention, Regression Safety & Resource-Aware Execution

**Baseline:** Zelari 2.5.0  
**Target suggerito:** Zelari 2.6 per il nucleo; 2.7+ per gli esperimenti successivi  
**Stato:** proposta operativa consolidata

---

# 1. Obiettivo

Il prossimo ciclo di Zelari non dovrebbe aggiungere nuovi agenti o nuove modalità per principio.

Le priorità sono due:

1. **rendere sicura e misurabile l'evoluzione del harness stesso**;
2. **rendere l'agente consapevole delle risorse residue senza perdere il controllo host-side**.

Il sistema target deve garantire contemporaneamente:

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

Principio guida:

> **Una nuova versione di Zelari deve dimostrare sia ciò che ha imparato a fare, sia ciò che non ha dimenticato, e deve spendere le risorse in modo coerente con la probabilità di arrivare a una soluzione verificata.**

---

# 2. Cosa implementare

## Track A — Harness evolution safety

1. **Harness Manifest**
2. **Historical Anchor Set**
3. **Harness Regression Gate**
4. **First-class TaskContract**
5. **Harness Change Classification**
6. **Eval Result Store**

## Track B — Resource-aware execution

7. **Central ResourceBudget / ResourceLedger**
8. **Model-visible latest resource snapshot**
9. **Verification Budget Reserve**
10. **Budget-aware continuation / repair / pivot**
11. **Unified Cost Metric negli eval**

## Track successivi, condizionati ai benchmark

12. Gauntlet piece budget allocation
13. Model/profile-specific budget curves
14. `--effort efficient|balanced|thorough`
15. Guarded project memory
16. Candidate router optimization
17. Adaptive Eval / SPADE integration

---

# 3. Cosa NON implementare ora

Non entra nel ciclo 2.6:

- auto-modifica del harness in produzione;
- BATS completo;
- tree search general-purpose;
- continue-after-PASS automatico;
- auto-installazione di skill;
- router self-modifying;
- RL/self-play runtime;
- nuovi Council roles;
- nuovi agenti;
- plugin framework general-purpose;
- nuovo sistema di compaction;
- database obbligatorio;
- prompt auto-update su `main`.

Zelari 2.5 possiede già una compaction più adatta al coding rispetto a quella del paper budget-aware.

---

# 4. Priorità

| Priorità | Feature | Valore | Complessità | Target |
|---|---|---:|---:|---|
| P0 | Harness Manifest | Molto alto | Bassa/Media | 2.6 |
| P0 | Historical Anchors | Molto alto | Media | 2.6 |
| P0 | Harness Regression Gate | Molto alto | Media | 2.6 |
| P0 | ResourceBudget / ResourceLedger | Molto alto | Media | 2.6 |
| P0 | Verification Budget Reserve | Molto alto | Media | 2.6 |
| P1 | Model-visible budget snapshot | Molto alto | Bassa | 2.6 |
| P1 | First-class TaskContract | Alto | Media | 2.6 |
| P1 | Unified Cost Metric | Molto alto | Bassa | 2.6 |
| P1 | Budget-aware repair/pivot | Alto | Media | 2.6 |
| P1 | Harness Change Classification | Alto | Bassa | 2.6 |
| P2 | Eval Result Store | Medio/Alto | Bassa | 2.6 |
| P2 | Gauntlet piece allocation | Alto | Media | 2.7 |
| P2 | Model-specific budget curves | Alto R&D | Media | 2.7 |
| P2 | `--effort` presets | Medio | Bassa | dopo dati |
| P2 | Guarded Memory | Alto | Medio/Alta | post-2.6 |
| P2 | Candidate Router Optimization | Medio/Alto | Alta | post-2.6 |
| P2 | Adaptive Eval Integration | Alto R&D | Alta | separato |

Ordine consigliato:

```text
Harness Manifest
      ↓
Historical Anchors
      ↓
Regression Gate
      ↓
ResourceBudget / Ledger
      ↓
resource.snapshot
      ↓
Verification Reserve
      ↓
TaskContract
      ↓
Budget-aware continuation
      ↓
Unified Cost Metric
      ↓
Targeted anchor selection
      ↓
Extended R&D
```

---

# 5. Architettura target

```text
                         USER TASK
                             │
                             ▼
                        TaskContract
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼                     ▼
             Harness Manifest      ResourceBudget
                  │                     │
                  │                ResourceLedger
                  │                     │
                  └──────────┬──────────┘
                             ▼
                     Runtime / AgentHarness
                             │
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
              ToolRegistry  Session  Verification
                  │          Spine       Engine
                  │            │           │
                  └────────────┼───────────┘
                               ▼
                      CompletionPolicy
                               │
                     verified outcome
                               │
                               ▼
                        Eval / Anchors
                               │
                               ▼
                      Regression Gate
```

---

# 6. Workstream A — Harness Manifest

## 6.1 Problema

Il comportamento di Zelari dipende da più elementi del semplice modello/profile:

- system prompt;
- Kraken/Gauntlet/Council/Mission prompt;
- tool descriptions;
- skill contents;
- routing;
- criteria pack;
- verification/completion policy;
- compaction policy;
- feature flag comportamentali;
- resource policy.

Due run con stesso modello possono quindi essere semanticamente diversi.

## 6.2 Obiettivo

Creare una rappresentazione canonica, versionata e hashabile del harness effettivo.

## 6.3 Contratto

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

I campi comportamentali contengono hash canonici, non testo raw.

## 6.4 Hash canonico

```ts
function hashHarnessManifest(
  manifest: HarnessManifestV1
): string
```

Requisiti:

- serializzazione canonica;
- ordine stabile;
- no timestamp;
- no valori runtime volatili;
- stesso harness → stesso hash.

## 6.5 Session integration

Nuovo evento state-only:

```text
session.harness_manifest
```

```ts
{
  manifest: HarnessManifestV1;
  manifestHash: string;
}
```

## 6.6 Resource policy nel manifest

La policy di budget è comportamentale e deve influenzare il manifest.

Esempio:

```ts
resourcePolicyHash = hash({
  maxToolCalls: 40,
  verificationReserve: 6,
  repairReserve: 4,
  wallClockMs: 900000
})
```

## 6.7 File suggeriti

```text
packages/core/src/runtime/
├── harnessManifest.ts
├── profiles.ts
└── index.ts

packages/core/src/session/
└── types.ts

src/cli/
└── harnessManifest.ts
```

## 6.8 Test

- stesso harness → stesso hash;
- prompt cambia → hash diverso;
- tool description cambia → hash diverso;
- resource policy cambia → hash diverso;
- manifest ricostruibile dopo resume.

## 6.9 Exit criteria

- ogni nuova sessione registra il manifest;
- ogni eval outcome è attribuibile a un manifest preciso;
- le variazioni comportamentali sono tracciabili.

---

# 7. Workstream B — Historical Anchor Set

## 7.1 Obiettivo

Costruire una suite piccola, stabile e verificabile di capacità che Zelari non deve perdere.

Domanda:

> “La candidate version ha rotto task che la baseline risolveva già?”

## 7.2 Struttura

```text
eval/anchors/
├── local-bugfix/
├── multi-file/
├── verification/
├── compaction/
├── recovery/
├── resource-budget/
├── kraken-delegation/
├── gauntlet/
├── council/
└── mission/
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

## 7.4 Proprietà obbligatorie

Ogni anchor:

- setup deterministico;
- task versionato;
- successo meccanicamente verificabile;
- limite tool/token/tempo;
- fixture ripristinabile;
- niente segreti;
- niente dipendenza da stato utente.

## 7.5 Tier

### Tier 0
Smoke veloci, PR blocking.

### Tier 1
Core retention, merge/release gate.

### Tier 2
Costosi/provider-sensitive, nightly/RC.

## 7.6 Bootstrap

15–25 anchor iniziali:

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

Golden = verified outcome + cost metrics, non output narrativo LLM.

---

# 8. Workstream C — Harness Regression Gate

## 8.1 Obiettivo

Confrontare:

```text
baseline H
vs
candidate H'
```

su:

- capability acquisition;
- historical retention;
- validity;
- resource efficiency.

## 8.2 Risultato

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

## 8.4 Preset

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
18/20 → 20/20
+2

Historical anchors
78/80 → 77/80
-1

Cost / verified solve
$0.18 → $0.31
+72%

Retention budget
0

RESULT:
REJECT
```

---

# 9. Workstream D — Central ResourceBudget & ResourceLedger

## 9.1 Problema

Zelari già applica diversi limiti:

- max tool calls;
- max tool-loop iterations;
- Mission budgets;
- Gauntlet rounds/pieces/parallelism;
- wall clock.

Ma sono principalmente **host constraints** distribuiti.

Manca una rappresentazione centrale e ricostruibile dello stato delle risorse.

## 9.2 Obiettivo

Separare:

```text
budget enforcement
```

da:

```text
budget awareness
```

L'host continua a possedere e imporre i limiti.

Il modello riceve solo una proiezione controllata del budget residuo.

## 9.3 Contratto

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

Il ResourceLedger è host-owned.

## 9.5 Invarianti

- `used <= limit` salvo evento finale di hard limit;
- `remaining = limit - used`;
- reserve non negativa;
- il modello non può modificare il budget;
- ToolRegistry resta il choke point;
- budget state ricostruibile dal Session log.

---

# 10. Workstream E — `resource.snapshot` nella Session

## 10.1 Evento

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

Il ledger conserva tutti gli snapshot.

La model surface mostra solo l'ultimo:

```text
resource.snapshot #1
resource.snapshot #2
resource.snapshot #3
        ↓
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

Aggiornare almeno dopo:

- tool batch;
- phase change;
- reserve threshold crossed;
- verification start;
- repair start.

---

# 11. Workstream F — Verification Budget Reserve

## 11.1 Problema

Un coding agent può consumare quasi tutte le risorse prima di arrivare a:

- test;
- typecheck;
- build;
- diff review;
- repair;
- retest.

Questo contraddice:

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

Non creare sub-budget rigidi per ogni fase.

## 11.3 Enforcement

Quando:

```text
remaining <= verificationReserve
```

le azioni non essenziali vengono limitate o fortemente scoraggiate.

### Consentite/prioritarie

- test;
- typecheck;
- build;
- diff;
- leggere failure;
- repair mirato;
- retest.

### Da evitare

- esplorazione ampia;
- ricerche speculative;
- nuova architettura;
- delegazioni non essenziali.

## 11.4 Hard vs advisory

Default iniziale consigliato:

```text
verification reserve = protected
repair reserve = advisory
```

## 11.5 Completion interaction

Se il budget residuo non permette evidence required:

```text
CompletionPolicy != PASS
```

Preferire:

```text
BLOCKED / resource exhausted
```

a falso done.

---

# 12. Workstream G — Budget Pressure

## 12.1 Stati

```ts
type BudgetPressure =
  | "ample"
  | "normal"
  | "constrained"
  | "critical";
```

## 12.2 Semantica

### ample
- exploration utile;
- alternative ragionevoli;
- delegazione utile.

### normal
- convergere;
- ridurre ricerca speculativa.

### constrained
- chiudere gap noti;
- evitare nuovo scope;
- preservare verify reserve.

### critical
- verification/repair/finalizzazione;
- oppure BLOCKED onestamente.

## 12.3 Threshold

Non copiare percentuali da altri domini.

Derivarli da benchmark Zelari.

Prima implementazione:

```text
policy configurable
```

---

# 13. Workstream H — Budget-aware Continuation / Repair / Pivot

## 13.1 Obiettivo

Il budget non decide il PASS.

Decide **come spendere le risorse residue**.

```text
VerificationEngine
→ deterministic truth

ResourcePolicy
→ next-action feasibility
```

## 13.2 Decisione

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

## 13.3 Esempi

### GAP + ample

```text
23 calls remaining
8 min remaining
→ repair
```

### repeated GAP

```text
same failure repeated 3 times
18 calls remaining
→ pivot
```

### structural GAP + critical

```text
4 calls remaining
→ hold
```

### deterministic PASS

```text
→ complete
```

Non continuare solo perché resta budget.

## 13.4 Mission

Integrare nella continuation policy esistente.

User steer continua a vincere.

## 13.5 Gauntlet

Combinare:

```text
PASS/GAP/BLOCKED
+
ResourceBudget
```

senza cambiare l'autorità del critic o della CompletionPolicy.

---

# 14. Workstream I — First-class TaskContract

## 14.1 Obiettivo

Smettere progressivamente di dedurre constraints e criteria dalla prosa.

```text
User prose
   ↓
TaskContract
   ↓
goal + constraints + acceptance criteria
```

## 14.2 Contratto

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

## 14.3 Autorità

```text
user > agent-derived
```

Un derived criterion non può:

- contraddire user constraint;
- cambiare goal;
- eliminare criterion richiesti.

## 14.4 Eventi

```text
task.contract
task.contract_updated
```

Append-only.

## 14.5 Compaction

`CompactionStateSnapshot` usa prima TaskContract.

Regex extraction resta fallback compatibility.

## 14.6 Verification

Required criteria entrano nello stesso:

```text
VerificationEngine
→ CompletionPolicy
```

## 14.7 Resource integration

TaskContract può in futuro esporre `risk`, ma non deve possedere il budget.

ResourcePolicy resta host-owned.

---

# 15. Workstream J — Unified Cost Metric

## 15.1 Obiettivo

Non valutare un harness solo su solve rate.

Misurare:

```text
quality
+
cost
+
latency
```

## 15.2 Tipo

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

## 15.3 Metriche principali

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

Un aumento di solve rate non implica promozione automatica.

---

# 16. Workstream K — Harness Change Classification

## 16.1 Classi

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
→ anchor gate

structural
→ anchor gate + invariants

cosmetic
→ standard CI
```

## 16.3 Manifest diff

```ts
diffHarnessManifest(oldManifest, newManifest)
```

Usare il diff per targeted anchors.

---

# 17. Workstream L — Eval Result Store

Niente DB obbligatorio.

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

SQLite solo se i volumi lo richiederanno.

---

# 18. Gauntlet piece budget allocation — fase successiva

Non blocca 2.6.

## 18.1 Tipo

```ts
interface PieceBudgetHint {
  pieceId: string;
  weight: number;
  minVerificationCalls: number;
}
```

Il decomposer può suggerire pesi.

L'host decide la policy reale.

> Il modello propone priorità; l'host possiede le risorse.

---

# 19. Model/profile-specific budget curves — fase successiva

Misurare:

```text
model × profile × budget
```

Esempio:

```text
Model A / Kraken
20 calls → 68%
40 calls → 80%
60 calls → 80%

Model B / Kraken
20 calls → 55%
40 calls → 70%
60 calls → 77%
```

Usare i dati per default e tuning futuri.

---

# 20. `--effort` presets — solo dopo dati

Possibile UX futura:

```text
--effort efficient
--effort balanced
--effort thorough
```

Non introdurre i preset prima di benchmark empirici.

---

# 21. Guarded Project Memory — fase successiva

```text
verified successful sessions
      ↓
candidate lesson
      ↓
candidate Harness Manifest
      ↓
Historical Anchors
      ↓
Regression Gate
      ↓
commit / reject
```

La memory non entra automaticamente.

---

# 22. Candidate Router Optimization — fase successiva

```text
eval data
↓
candidate routing policy
↓
new Harness Manifest
↓
anchors
↓
Regression Gate
↓
commit / reject
```

Mai self-update in produzione.

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
      ↓
candidate improvement
      ↓
candidate manifest
      ↓
new-task eval
      ↓
historical anchors
      ↓
cost comparison
      ↓
retention policy
      ↓
commit / reject
```

---

# 24. Session events proposti

Nuovi state-only events:

```text
session.harness_manifest
task.contract
task.contract_updated
resource.snapshot
resource.limit_reached
resource.reserve_entered
```

## 24.1 Invarianti

### Harness Manifest
- un manifest attivo per session start;
- update solo tramite nuovo event/versione.

### TaskContract
- version monotona;
- user source seq valido.

### Resource
- used monotono per risorse cumulative;
- remaining coerente;
- reserve non negativa;
- tool budget non contato due volte.

---

# 25. File suggeriti

## Core runtime

```text
packages/core/src/runtime/
├── harnessManifest.ts        NEW
├── resourceBudget.ts         NEW
├── resourcePolicy.ts         NEW
└── profiles.ts               UPDATE
```

## Session

```text
packages/core/src/session/
├── types.ts                  UPDATE
├── invariants.ts             UPDATE
├── modelSurface.ts           UPDATE
└── taskContract.ts           NEW
```

## Verification / Mission

```text
packages/core/src/verification/
└── types.ts / engine.ts      UPDATE if needed

packages/core/src/mission/
└── continuationPolicy.ts     UPDATE
```

## CLI

```text
src/cli/budget/
├── resourceLedger.ts         NEW
├── resourceSnapshot.ts       NEW
└── modelContextBuilder.ts    UPDATE

src/cli/gauntlet/
├── loop.ts                   UPDATE
└── policy.ts                 UPDATE

src/cli/kraken/
└── taskContract.ts           NEW/UPDATE
```

## Eval

```text
tools/eval/
├── anchorRunner.ts
├── regressionGate.ts
├── retentionPolicy.ts
├── cost.ts
├── report.ts
├── targetedAnchors.ts
└── types.ts
```

---

# 26. Test strategy

## 26.1 Harness Manifest

- deterministic hash;
- resource policy changes hash;
- prompt/tool change changes hash;
- resume equality.

## 26.2 ResourceBudget

- decrement tool calls;
- no double-count;
- reserve activation;
- hard limit;
- resume reconstruction;
- model cannot mutate budget.

## 26.3 Resource snapshot

- only latest visible;
- old snapshots remain nel ledger;
- compaction preserves latest state;
- resume produces same surface.

## 26.4 Verification reserve

- exploration non consuma protected reserve;
- verify calls consentite;
- insufficient resources → BLOCKED, non PASS;
- deterministic PASS termina anche con budget residuo.

## 26.5 Continuation policy

- GAP + ample → repair;
- repeated GAP + budget → pivot;
- structural GAP + critical → hold;
- PASS → complete.

## 26.6 Historical Anchors

- deterministic setup/reset;
- timeout;
- tool budget;
- verified success.

## 26.7 Regression Gate

- zero-regression stable;
- one-regression experimental;
- validity failure always rejects;
- cost policy violation riportata correttamente.

## 26.8 TaskContract

- user constraint preserved;
- derived criteria logged;
- user wins conflict;
- steer versioning;
- compaction preservation.

---

# 27. Benchmark matrix

Creare benchmark su:

```text
model
×
profile
×
resource policy
×
task class
```

## 27.1 Task class

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

## 27.3 Metriche

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

## Phase 1 — Shadow

- Harness Manifest ON;
- anchor runner ON;
- Regression Gate report-only;
- resource snapshots telemetry-only;
- budget awareness non blocking.

## Phase 2 — Resource awareness

- latest snapshot model-visible;
- verification reserve advisory.

## Phase 3 — Protected verification reserve

- Kraken BUILD first;
- Mission/Gauntlet dopo smoke.

## Phase 4 — Regression gate blocking

- Tier 0 PR blocking;
- Tier 1 merge/release blocking.

## Phase 5 — Budget-aware repair/pivot

- prima Gauntlet;
- poi Mission;
- Kraken solo con benchmark positivo.

---

# 29. Sequenza PR consigliata

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

# 30. Milestone proposta — Zelari 2.6

La 2.6 può essere considerata completa quando:

- [ ] ogni sessione registra `HarnessManifest`;
- [ ] resource policy è inclusa nel manifest;
- [ ] esistono 15–25 anchor stabili;
- [ ] Tier 0 gira in CI;
- [ ] Regression Gate confronta candidate vs baseline;
- [ ] retention budget è esplicito;
- [ ] `ResourceBudget` è centrale;
- [ ] ResourceLedger è ricostruibile;
- [ ] latest `resource.snapshot` è model-visible;
- [ ] verification reserve esiste;
- [ ] deterministic PASS termina senza spendere budget residuo;
- [ ] resource exhaustion non produce false PASS;
- [ ] TaskContract è first-class;
- [ ] compaction usa TaskContract quando disponibile;
- [ ] Gauntlet/Verification condividono criteria;
- [ ] cost per verified solve è misurato;
- [ ] manifest diff identifica behavioral changes.

Non è requisito 2.6:

- Gauntlet piece allocator;
- effort presets;
- adaptive memory;
- auto router;
- SPADE generator.

---

# 31. Metriche di successo

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

deve diminuire o restare invariato.

---

# 32. Guardrail contro scope creep

Una nuova feature entra solo se migliora almeno una delle seguenti:

1. verified solve rate;
2. false-done rate;
3. retention;
4. token/cost efficiency;
5. latency;
6. recoverability;
7. measurability.

Se non migliora nessuna:

```text
non entra
```

---

# 33. Decisioni esplicite

## Prendiamo

- retention gate;
- historical anchors;
- harness manifest;
- TaskContract;
- resource budget awareness;
- verification reserve;
- budget-aware repair/pivot;
- unified cost evaluation.

## Non prendiamo

- BATS completo;
- continue-after-PASS default;
- verifier LLM come completion authority;
- nuova compaction;
- auto-self-improvement in production.

---

# 34. Architettura finale

```text
                           TASK
                            │
                            ▼
                       TaskContract
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   HarnessManifest    ResourceBudget     SessionSpine
          │                 │                 │
          │           ResourceLedger          │
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
                     AgentHarness
                            │
                      ToolRegistry
                            │
                      real effects
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
         VerificationEngine       resource state
                │                       │
                ▼                       ▼
         CompletionPolicy      repair/pivot/hold
                │
                ▼
         verified outcome
                │
                ▼
            Eval Store
                │
        ┌───────┴────────┐
        ▼                ▼
  New-target eval   Historical Anchors
        │                │
        └───────┬────────┘
                ▼
         Regression Gate
                │
         ┌──────┴──────┐
         ▼             ▼
      COMMIT          REJECT
```

---

# 35. Principio finale

Zelari non deve diventare un sistema che “usa più risorse perché può”.

Deve diventare un sistema che sa:

```text
quale obiettivo deve soddisfare
+
quali prove deve ancora produrre
+
quanto budget gli rimane
+
quali capacità storiche non deve perdere
+
quanto costa davvero ottenere un verified solve
```

Regola finale:

> **Spendere budget è giustificato solo se aumenta la probabilità di arrivare a una soluzione verificata; cambiare il harness è giustificato solo se migliora il sistema senza dimenticare ciò che già sapeva fare.**
