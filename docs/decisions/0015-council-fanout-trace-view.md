
- **Stato:** ✅ Accettato (Fase A implementata; Fase B deferita)
- **Data proposta:** 2026-07-20
- **Autore:** Zelari Code (fase PLAN)
- **Ispirazione:** From Loop Engineering to Graph Engineering (Carlos
  Perez/@IntuitMachine, lug 2026) — *"graphs force you to admit how much of
  the workflow you haven't modeled yet"*; divide → communicate → synchronize.
- **Dipende da:** `MemberCostTracker` (`src/cli/councilCost.ts`),
  `SliceRunResult`/`MissionState` (`src/cli/zelariMission.ts`),
  `checkpointManager.ts` (`src/cli/checkpoint/`).

## Contesto

Due facce della stessa medaglia, entrambe emerse dal confronto con "Graph
Engineering". Zelari-code ha un **org-graph stabile** (i 6 membri fissi:
Caronte→Lucifero) ma nasconde due debolezze rispetto a un vero grafo di
esecuzione:

### 1. Specialisti sequenziali (manca divide→synchronize)

I membri del council girano **in sequenza**, non in parallelo. Conferma nel
codice, commento esplicito in `councilCost.ts:100`:

```ts
/** Total wall-clock time across all members. Note: this is sum-of-mems,
 *  not elapsed council time (specialists run sequentially). */
totalDurationMs(): number { ... }
```

Il flusso attuale: `dispatchCouncil` (`councilDispatcher.ts:86`) →
`runCouncilPure` (package `@zelari/core/council`) orchestra i membri **uno dopo
l'altro**. Il "graph engineering" insiste che i rami indipendenti di un DAG
dovrebbero girare in parallelo (divide), comunicare allo sync-point
(communicate), poi procedere (synchronize).

### 2. Nessuna osservabilità per-nodo (manca il "graph" visibile)

`MemberCostTracker` raccoglie dati **estremamente ricchi** per ogni membro
(`councilCost.ts:21-38`):

```ts
export interface MemberCost {
  memberId: string;       // 'charont' | 'nettun' | 'minos' | 'lucifer' ...
  name: string;           // 'Caronte'
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;     // latenza di questo membro
  toolCalls: number;      // tool_execution_start eventi
  errored: boolean;       // questo ramo ha divergé/fallito
}
```

e li serializza già in modo pulito via `toJSON()` → `{ ts, costs[] }`. Ma
questi dati **non raggiungono mai un'interfaccia di ispezione**:

- `SliceRunResult` (`zelariMission.ts:47-61`) riporta `completionOk`,
  `writeCount`, `degraded` — **ma NON i costi per membro**.
- Non esiste un `.zelari/trace/<missionId>.json` persistito.
- Non esiste un comando `/trace` o `zelari-code trace show`.
- `MissionState` (`zelariMission.ts:32-44`) non ha campo trace.

Il dato c'è; la sua **superficizzazione** manca. È esattamente il gap tra
"loop che gira" e "graph che puoi debuggare".

## Decisione

Si scinde in **due fasi indipendenti**, perché hanno rischio/opportunità molto
diversi. **Fase A prima** (basso rischio, alto valore, sblocca il giudizio su
Fase B).

### Fase A — Trace View (implementare ora)

Raccogliere, persistere e renderizzare il grafo di esecuzione che **esiste già
nei dati** ma non viene superfizzato:

1. **Estendere `SliceRunResult`** (`zelariMission.ts:47`) con
   `costs?: MemberCost[]`. Il driver (`runHeadlessZelari`, che crea già il
   tracker nel council) passa `tracker.finalize()` nel risultato di ogni slice.

2. **Estendere `MissionState`** (`zelariMission.ts:32`) con
   `trace?: SliceTrace[]` dove `SliceTrace = { sliceId, iteration, runMode,
   costs: MemberCost[], completionOk, degraded }`. `runZelariMission`
   accorpa i costi per slice a ogni iterazione.

3. **Persistere** `.zelari/trace/<missionId>.json` con il grafo completo:
   per ogni slice → membri (in ordine di esecuzione), token, costo USD
   (via `calculateCost` di `modelPricing.ts`), latenza, errore, flag degraded.
   Questo file è la base di ogni visualizzazione.

4. **Nuovo comando** `/trace` (TUI) e `zelari-code trace show <missionId>`
   (headless): renderizzano il DAG di esecuzione come lista strutturata
   (ASCII o JSON). Mostra: chi è girato, in che ordine, quanto è costato, dove
   ha divergé (`errored`/`degraded`).

**Risultato:** risposta concreta a *"dove ha divergé il piano?"* senza dover
scavare nei log.

### Fase B — Fan-Out Parallelo (DEFERITO — non in questo ADR come lavoro attivo)

Parallelizzare i membri **indipendenti** del council. Identificato ma non
implementato ora, per tre ragioni:

1. **Il grafo di dipendenze è oggi IMPLICITO** nell'ordine sequenziale. Per
   parallelizzare serve renderlo esplicito: chi può girare in parallelo, chi
   deve aspettare. Minosse giudica **dopo** gli specialisti; Lucifero
   sintetizza **alla fine**. Il grafo è un DAG, non un set — non tutto è
   parallelizzabile.
2. **Conflitto di stato**: specialisti paralleli che scrivono sullo stesso
   working tree si pestano i piedi. Servirebbe `git worktree add` multiplo
   (estensione di `checkpointManager.ts`, che oggi opera su repo singolo via
   git plumbing: `createCheckpoint`/`restoreCheckpoint`).
3. **Non-determinismo nell'accumulazione**: lo stato durevole (Palmer) è
   sequenziale per costrutto; parallelizzarlo richiede ridefinire il modello
   di merge.

**Criterio di sblocco per Fase B:** si implementa solo se la Fase A (trace
view) mostra che il collo di bottiglia di una missione è **davvero** il tempo
dei membri sequenziali, non il numero di iterazioni o la qualità del verifier.

## Consequenze

**Fase A (ora):**
- Osservabilità immediata: debug di *"Minosse ha rigettato la slice 3 costing
  12k token — perché?"* diventa un `cat .zelari/trace/<id>.json`.
- Zero rischio funzionale: i dati sono già raccolti; si aggiungono solo
  persistenza + render. Il loop non cambia semantica.
- Base per futuri miglioramenti: il trace JSON alimenta anche il budget cap
  (ADR-0013) e potenziali dashboard.

**Fase B (deferito):**
- Speedup potenziale (N specialisti in parallelo → wall-clock ≈ max anziché
  sum), MA introduce non-determinismo e conflitti.
- **Non si fa finché** Fase A non quantifica il win.

## Alternative considerate

1. **Trace nello stderr/log esistente.** Rifiutato: non strutturato, non
   interrogabile, perso al termine della sessione. Preferito JSON persistito
   per-missione.
2. **Parallelizzare tutto subito (Fase B prima).** Rifiutato: alto rischio,
   payoff non dimostrato. Fase A prima serve a *misurare* se il sequenziale è
   davvero il problema.
3. **Trace come evento nello stream BrainEvent esistente.** Considerato: il
   council emette già eventi (`onCouncilStatus`). Ma il trace per-missione
   ha bisogno di persistenza oltre la sessione (debug post-mortem), quindi un
   file JSON è più adatto di un evento effimero. Gli eventi possono *alimentare*
   il file, ma il file resta la source of truth.

## Punti di integrazione concreti (Fase A)

| File | Modifica | Effort |
|---|---|---|
| `src/cli/zelariMission.ts:47` (`SliceRunResult`) | aggiungere `costs?: MemberCost[]` | XS |
| `src/cli/zelariMission.ts:32` (`MissionState`) | aggiungere `trace?: SliceTrace[]` + tipo | S |
| `src/cli/zelariMission.ts:200` (`runZelariMission`) | accorpa `result.costs` in `state.trace` a ogni iter | S |
| `src/cli/runHeadless.ts:996` (dove si costruisce `sliceResult`) | passare `tracker.finalize()` in `costs` | S |
| nuovo `src/cli/traceStore.ts` | `saveTrace(missionId, trace)`, `loadTrace(missionId)` → `.zelari/trace/<id>.json` | S |
| nuovo `src/cli/slashHandlers/trace.ts` | comando `/trace` | S |
| `src/cli/main.ts` (help) | `trace show <id>` subcommand | S |
| `modelPricing.ts:112` (`calculateCost`) | già esiste — arricchisce il trace con USD | — |

**Tipi proposti:**

```ts
export interface SliceTrace {
  sliceId: string;
  iteration: number;
  runMode: CouncilRunMode;
  costs: MemberCost[];      // per-membro, in ordine di esecuzione
  totalCostUsd?: number;    // via calculateCost
  completionOk: boolean;
  degraded?: boolean;
  startedAt: string;
  durationMs: number;
}
```

**Test di accettazione (Fase A):**
- Dopo una missione, `.zelari/trace/<missionId>.json` esiste e contiene una
  entry per slice con i costi per membro.
- `/trace` renderizza l'ordine dei membri + flag `errored`/`degraded`.
- Una slice in cui Minosse restituisce `errored: true` è visibile nel trace.
- Il trace include `totalCostUsd` (richiama ADR-0013 budget cap: stesso dato).
