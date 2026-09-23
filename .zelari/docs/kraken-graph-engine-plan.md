# Kraken Graph Engine — Piano raffinato (post-validazione)

> Stato: **PLAN** (ipotesi di design, non ancora implementato).
> Validato contro il codice reale il turno corrente. Ogni affermazione della proposta
> originale è stata verificata sul disco; le correzioni sono marcate **[CORREZIONE]**.
> Per implementare: passare in **BUILD**.

---

## 0. Verdetto di validazione (cosa è vero, cosa va corretto)

### Confermato dalla proposta (accurato)
- `AgentHarness` (`packages/core/src/core/AgentHarness.ts`) è provider-neutral, `AsyncIterable<BrainEvent>`. ✓
- **Il parallelismo within-turn esiste già**: `isParallelSafeTool('task')` ritorna `true`
  (linee 288–306) e `executePendingTools` (313–481) esegue i tool parallel-safe via
  `Promise.all` chunked da `ZELARI_MAX_PARALLEL_TOOLS` (default 6). ✓
  → Il collo di bottiglia è proprio quello descritto: il LLM deve *emettere* più `task` in un turno.
- `taskTool.ts`: 3 kind (explore/general/verify), `SubAgentContext`, worktree, auto-merge,
  verify-hint footer, radio, live. ✓
- `runSubAgent` è **privata** (non esportata) → va esposta/estratta. ✓ (la proposta lo dice)
- `krakenWorktree.ts`: squash-merge *singolo* in HEAD; su conflitto `reset --merge` + report.
  Nessun merge multi-worktree, nessuna auto-risoluzione conflitti. ✓
- `krakenLive.ts`: nessun `graphId/nodeId/deps`. ✓ — `krakenRadio.ts`: kind solo
  spawn/progress/done/error/verify_hint. ✓ — `krakenModel.ts`: routing cheap per explore/verify. ✓
- Cap spawn: `ZELARI_KRAKEN_MAX_TASK_SPAWNS` default **6**, hard-cap 32. ✓
  **[CORREZIONE-semantica]**: è un *contatore per-turno* (reset via `resetTaskSpawnCount()`),
  NON un limite di concorrenza. Un grafo con 8+ nodi lo sfora se passa dal tool `task`.
- I tool **world-model SONO reali**: `src/cli/workspace/worldModel.ts` esporta
  `updateWorldHypothesisTool`, `setWorldChecksTool`, `runBacktestTool`,
  `recordWorldObservationTool` (via `createWorldModelTools()`, kill-switch `ZELARI_SCHEMA_LOOP=0`).
  → Il "Livello 3" della proposta **non** è una confabulazione. ✓

### Correzioni architetturali decisive
1. **[CORREZIONE-1 — package boundary]** La proposta mette tutto in `packages/core/src/kraken/`.
   **Non compila**: `executor`/`planner` dipendono da `taskTool`, `krakenWorktree`,
   `worldModel`, `toolRegistry` che stanno in `src/cli` (il package CLI dipende da core,
   non viceversa). **Split obbligatorio**:
   - `packages/core/src/kraken/` → **solo logica pura** (tipi, validazione topologica,
     scope-overlap). Zero import da `src/cli`. Unit-testabile senza CLI.
   - `src/cli/kraken/` → **orchestrazione** (planner LLM, executor, wiring worktree/worldModel/radio/live).
2. **[CORREZIONE-2 — Livello 3 opzionale]** I world-model tool stanno in `src/cli/workspace`,
   non in core. Il gate di convergenza via `run_backtest` va reso **opzionale**: si attiva solo
   se `.zelari/world/checks.json` esiste E `ZELARI_SCHEMA_LOOP != 0`. La self-correction
   (Livello 1+2) NON dipende dal world model e resta il core.
3. **[CORREZIONE-3 — integration seam]** `src/cli/slashHandlers/kraken.ts` **non esiste**
   (handler presenti: branch/cache/checkpoint/git/plugins/promoteMember/provider/semantic/
   skills/state/transcript/updater/workspace). `/kraken graph` è **net-new**.
   `useChatTurn.ts` è enorme (~2000 righe, 3 dispatcher): **non** mutarlo in v1.
   Integrazione v1 a basso rischio = slash handler `/kraken` + flag headless dedicati,
   che girano il graph engine standalone. Wiring profondo in `useChatTurn` → fase successiva.
4. **[CORREZIONE-4 — merge onesto]** `mergeKrakenWorktree` mergia UN branch in HEAD.
   v1 = merge sequenziale dei worktree a scope disgiunti (riusa il codice esistente).
   "fix-node che risolve conflitti" = **STRETCH**, non v1 (su conflitto: keep branch + surface all'utente).

---

## 1. Mappa dei componenti (con path verificati)

### Nuovo — `packages/core/src/kraken/` (PURO, no dipendenze CLI)
| File | Contenuto |
|---|---|
| `graph.ts` | Tipi `TaskNode`/`TaskGraph`/`TaskNodeKind`/`TaskNodeStatus`; `validateGraph()` (no cicli, deps esistenti, bound `MAX_NODES`); `getReadyNodes()`; `topoLevels()`. |
| `conflict.ts` | `pathsOverlap(a,b)` (glob/prefix match puro); `canRunParallel(a,b)`; `disjointScopeSets()`. |
| `graph.test.ts` / `conflict.test.ts` | Unit test puri (vitest). |

### Nuovo — `src/cli/kraken/` (orchestrazione, dipende da core + cli/tools)
| File | Contenuto |
|---|---|
| `tentacle.ts` | `runTentacle(opts): Promise<TentacleResult>` — **estratto** da `taskTool.execute`: build `SubAgentContext` (stessi deps di `createBuiltinToolRegistry` linee 322–363), harness, `runSubAgent`, worktree create/merge, radio, live. Condiviso da tool `task` e graph executor. |
| `executor.ts` | `KrakenGraphExecutor.execute(): AsyncIterable<GraphEvent>` — pool fan-out (`ZELARI_KRAKEN_MAX_PARALLEL`), retry+fix budget, auto-verify successor, merge sequenziale, gate `run_backtest` opzionale. |
| `planner.ts` | `planTaskGraph()` — chiamata LLM strutturata → DAG; parse JSON robusto; validazione (riusa `validateGraph`); auto-iniezione verify/merge. |
| `radioGraph.ts` (o estensione di `krakenRadio.ts`) | Eventi grafo: `graph_plan`, `node_start`, `node_end`, `node_retry`, `node_fix`, `graph_converged`, `graph_failed`. |
| `slashHandlers/kraken.ts` | **Net-new**: `/kraken graph <prompt>`, `/kraken status` (DAG ASCII + radio/live). |

### Modifiche a file esistenti
| File | Modifica | Rischio |
|---|---|---|
| `src/cli/tools/taskTool.ts` | Esportare/estrarre `runTentacle` + `runSubAgent`; `execute` del tool diventa thin wrapper. Behavior-preserving. | Medio (refactor) |
| `src/cli/tools/krakenLive.ts` | Estendere `LiveTentacle` con `graphId?`, `nodeId?`, `deps?` (campi opzionali → retrocompat). | Basso |
| `src/cli/tools/krakenRadio.ts` | Aggiungere kind grafo (union estesa) — retrocompat. | Basso |
| `packages/core/src/agents/promptModules.ts` | Nuovo modulo `KRAKEN_PLANNER_MODULE`. | Basso |
| `src/cli/components/StatusBar.tsx` | Chip "graph 3/8 · 2↑" da `krakenLive` esteso. | Basso |
| `src/cli/headless.ts` / `runHeadless.ts` | Flag `--kraken-graph` per esecuzione headless del grafo. | Medio |

---

## 2. Self-correction (i 3 livelli, corretti)

- **Livello 1 — auto-verify**: `ensureVerifySuccessor(generalNode)` inietta un nodo `verify`
  se non presente (come nella proposta). Core, sempre attivo (`ZELARI_KRAKEN_VERIFY_AUTO=1`).
- **Livello 2 — retry + fix**: `handleFailure(node)` → retry con prompt arricchito dall'errore
  fino a `maxRetries` (default 2); poi spawn `fix-node` entro `ZELARI_KRAKEN_FIX_BUDGET` (default 3);
  oltre → `node_permanent_failure` (il grafo continua sugli altri rami). Core.
- **Livello 3 — world-model gate (OPZIONALE)**: dopo i verify, se `.zelari/world/checks.json`
  esiste e `ZELARI_SCHEMA_LOOP != 0`, l'executor chiama `run_backtest` come gate finale di
  convergenza; se `ok=false` spawn fix-node mirati. Se non ci sono check → skip pulito.
  **[CORREZIONE-2]**: non è un hard dependency.

---

## 3. Riconciliazione knob di parallelismo

| Knob | Dove | Default | Ruolo |
|---|---|---|---|
| `ZELARI_MAX_PARALLEL_TOOLS` | AgentHarness (within-turn) | 6 | Parallelismo tool_call emessi dal LLM in un turno. Indipendente dal grafo. |
| `ZELARI_KRAKEN_MAX_TASK_SPAWNS` | taskTool (contatore per-turno) | 6 (cap 32) | **Bypassato** dal graph executor (che chiama `runTentacle`, non il tool). |
| `ZELARI_KRAKEN_MAX_PARALLEL` | **NUOVO** executor | 12 | Concorrenza pool nodi del grafo. |
| `ZELARI_KRAKEN_MAX_NODES` | **NUOVO** planner/executor | 24 | Anti-esplosione grafo. |
| `ZELARI_KRAKEN_GRAPH` | **NUOVO** | 1 | Kill-switch modalità grafo (0 = legacy tentacoli ad-hoc). |
| `ZELARI_KRAKEN_VERIFY_AUTO` | **NUOVO** | 1 | Auto-iniezione verify. |
| `ZELARI_KRAKEN_MAX_RETRIES` | **NUOVO** | 2 | Retry per nodo. |
| `ZELARI_KRAKEN_FIX_BUDGET` | **NUOVO** | 3 | Max fix-node per grafo. |
| `ZELARI_KRAKEN_MERGE_STRATEGY` | **NUOVO** | squash | v1 solo `squash` (sequenziale); `rebase`/`manual` = stretch. |
| `ZELARI_SCHEMA_LOOP` | worldModel (esistente) | on | Gate Livello 3. |

---

## 4. Fasi (con acceptance + verifica)

### F1 — Core puro (nessuna dipendenza) — rischio BASSO
- `packages/core/src/kraken/{graph,conflict}.ts` + test.
- **Acceptance**: `validateGraph` rifiuta cicli/deps mancanti/>MAX_NODES; `getReadyNodes`
  corretto su DAG a diamante; `pathsOverlap` gestisce prefix/glob; `canRunParallel` conservativo
  (scope assente → non parallelo). `npm run test` verde.

### F2 — Refactor tentacle (behavior-preserving) — rischio MEDIO
- Estrarre `runTentacle` da `taskTool.execute`; esportare `runSubAgent`; il tool `task` diventa wrapper.
- **Acceptance**: `npm run test` + typecheck verdi; comportamento del tool `task` invariato
  (stessi footer/radio/live/worktree). Nessun cambio di contratto `BrainEvent`.

### F3 — Executor — rischio MEDIO/ALTO (cuore)
- `src/cli/kraken/executor.ts`: pool fan-out, retry, auto-verify, fix-budget, merge sequenziale,
  eventi radio/live estesi.
- **Acceptance**: dato un DAG fixture (explore→3 general paralleli→3 verify→merge→verify),
  l'esecuzione rispetta la topologia, manda in parallelo i nodi a scope disgiunti, retrya un verify
  fallito, converge. Test con harness factory mock (come nei test taskTool esistenti).

### F4 — Planner — rischio MEDIO
- `src/cli/kraken/planner.ts` + `KRAKEN_PLANNER_MODULE`.
- **Acceptance**: da un prompt + contesto produce JSON validato da `validateGraph`; auto-inietta
  verify dopo ogni general e un merge-node quando ≥2 general convergono; fallback robusto su JSON malformato.

### F5 — Observability — rischio BASSO
- Radio graph events, krakenLive graph fields, StatusBar chip, `/kraken graph` ASCII (slash net-new).
- **Acceptance**: `/kraken status` mostra DAG + stato; StatusBar mostra "graph x/y · n↑"; radio JSONL
  contiene gli eventi grafo.

### F6 — Integration + gate opzionale — rischio MEDIO
- `/kraken graph <prompt>` end-to-end, flag headless, gate `run_backtest` opzionale, env vars, e2e test.
- **Acceptance**: un prompt reale produce plan→execute→converge senza intervento utente; con
  `ZELARI_KRAKEN_GRAPH=0` si ricade nel comportamento legacy; typecheck+test+smoke verdi.

**Dipendenze**: F1 ← F2 ← F3 ← {F4, F5} ← F6. F1 e F2 sono i deliverable della prima slice BUILD.

---

## 5. Rischi aggiornati

| Rischio | Mitigazione |
|---|---|
| Inversione dipendenze core→cli | **[CORREZIONE-1]**: split pure/orchestration. Enforcement: core non importa mai `src/cli`. |
| Esplosione grafo | `MAX_NODES=24` + `validateGraph` nel planner. |
| Loop verify→fix infinito | `maxRetries` per nodo + `FIX_BUDGET` globale + `node_permanent_failure` terminale. |
| Conflitti merge paralleli | Scope disgiunti obbligatori per general paralleli; v1 merge sequenziale; conflitto → keep+surface (auto-resolve = stretch). |
| Costo LLM (12 agenti) | `krakenModel` routing cheap per explore/verify; general su modello primario. |
| Refactor taskTool rompe il tool | F2 behavior-preserving + test esistenti come rete. |
| Mutare useChatTurn (2000 righe) | **[CORREZIONE-3]**: v1 via slash/headless standalone; wiring profondo rinviato. |
| World model non configurato | **[CORREZIONE-2]**: Livello 3 skip pulito se no checks.json / `ZELARI_SCHEMA_LOOP=0`. |

---

## 6. Prima slice BUILD consigliata
Implementare **F1 + F2** in un turno (core puro + refactor tentacle), con test e typecheck,
poi checkpoint. Quindi F3 (executor) come slice successiva.
