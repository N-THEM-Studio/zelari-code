# ADR-0013: Budget cap (token/USD) come terza stop-rule della missione Zelari

- **Stato:** ✅ Accettato (implementato)
- **Data proposta:** 2026-07-20
- **Autore:** Zelari Code (fase PLAN)
- **Ispirazione:** Loop Engineering (rari/@0xwhrrari, giu 2026) + From Loop
  Engineering to Graph Engineering (Carlos Perez/@IntuitMachine, lug 2026)
- **Dipende da:** infrastruttura di costo già esistente — `councilCost.ts`
  (`MemberCostTracker`) e `modelPricing.ts` (`calculateCost`)

## Contesto

Ogni loop di agent affidabile ha **tre stop-rule indipendenti**
(vedi "Loop Engineering: Complete Guide", rari/@0xwhrrari):

1. **Success exit** — il verifier conferma il goal.
2. **Iteration cap** (MAX_ITERATIONS) — un loop bloccato non gira per sempre.
3. **Budget cap** — un loop impazzito non brucia l'intera spesa token/USD.

> *"Skipping the iteration and budget caps is how people wake up to a $400 API
> bill and an agent that looped 900 times on an impossible task."*

Zelari-code implementa **2 delle 3** stop-rule nel driver di missione
(`zelariMission.ts`):

| Stop-rule | Dove | Stato |
|---|---|---|
| Success exit | `if (completionOk) { state.status = 'success'; ... }` (`zelariMission.ts:~395`) | ✅ |
| Iteration cap | `DEFAULT_MAX_ITER = 6` + `ZELARI_MISSION_MAX_ITER` (`zelariMission.ts:110-116`) | ✅ |
| Stall detection | `DEFAULT_MAX_STALL = 2` + `noWriteStreak` (`zelariMission.ts:413-443`) | ✅ (bonus) |
| **Budget cap (token/USD)** | — | ❌ **MANCANTE** |

**Il contatore esiste già, la valvola no.** `MemberCostTracker`
(`councilCost.ts`) accumula `promptTokens`/`completionTokens`/`durationMs` per
membro; `modelPricing.ts:112` espone `calculateCost(model, prompt,
completion, cached?) → usd`. Ma nessuno di questi dati raggiunge il `while(true)`
di `runZelariMission` per fermare il loop quando la spesa supera un tetto.

Una missione Zelari con `councilSize: 6` e `MAX_ITER = 6` può emettere fino a
**6 × (5 specialisti + Minosse + Lucifero) = ~42 invocazioni LLM**, ciascuna con
tool-loop (fino a `maxToolLoopHardCap`). Su grok-4 ($3/$15 per 1M) questo è
potenzialmente decine di dollari in una singola missione senza alcun freno
diverso dal numero di iterazioni — che non pesa la *gravità* di ciascuna.

## Decisione

Aggiungere una terza stop-rule al driver di missione: un tetto cumulative su
**token totali** e/o **USD** spesi dall'inizio della missione, verificato ad
ogni iterazione del `while(true)`. La missione termina con `status: 'stopped'`
(un nuovo sub-reason `budget-exceeded`) quando il tetto è raggiunto.

### 1. Variabili d'ambiente (entrate nuove)

```
ZELARI_MISSION_MAX_COST=5.00      # USD cumulativi della missione (default: off)
ZELARI_MISSION_MAX_TOKENS=2000000 # token cumulativi (default: off)
```

Entrambe opzionali. Se non impostate, la stop-rule è disabilitata
(comportamento attuale, zero breaking change). Possono essere impostate
insieme: la prima che scatta vince.

### 2. Schema di risoluzione (specchia `resolveMaxIterations`)

In `zelariMission.ts`, accanto a `resolveMaxIterations` (riga 113):

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

### 3. Estensione di `SliceRunResult` (backward-compatible)

In `zelariMission.ts`, interfaccia `SliceRunResult` (riga ~37), aggiungere
campi opzionali:

```ts
export interface SliceRunResult {
  // ... campi esistenti ...
  /** Token totali (prompt+completion) consumati da questa slice. */
  costTokens?: number;
  /** Costo stimato in USD di questa slice. */
  costUsd?: number;
}
```

`undefined` = il driver non li riporta → stop-rule disabilitata (compat
all'indietro, come per `writeCount`).

### 4. Accumulo e check nel loop

In `runZelariMission` (riga ~206), dopo `maxStall`:

```ts
const maxCost = resolveMaxCost(deps.env);
const maxTokens = resolveMaxTokens(deps.env);
let cumulativeCost = 0;
let cumulativeTokens = 0;
```

Dopo `result = await deps.runSlice(...)` (riga ~320), accumulare:

```ts
if (typeof result.costTokens === 'number') cumulativeTokens += result.costTokens;
if (typeof result.costUsd === 'number') cumulativeCost += result.costUsd;
```

Aggiungere lo stop-check **dopo** l'accumulo, **prima** di `writeMissionState`
finale del ramo success/continue (cioè dopo la gestione del singolo step, prima
del prossimo giro del `while`). Posizionarlo insieme allo stall-detection:

```ts
// Budget cap: terza stop-rule (Loop Engineering).
if (
  (maxCost !== undefined && cumulativeCost >= maxCost) ||
  (maxTokens !== undefined && cumulativeTokens >= maxTokens)
) {
  state.status = 'stopped';
  state.updatedAt = now().toISOString();
  await writeMissionState(deps.projectRoot, state);
  const reason = maxCost !== undefined && cumulativeCost >= maxCost
    ? `budget USD ${formatCost(cumulativeCost)} ≥ ${formatCost(maxCost)}`
    : `token ${formatTokens(cumulativeTokens)} ≥ ${formatTokens(maxTokens!)}`;
  deps.emit(
    `[zelari] fermata: ${reason}. ` +
    'Imposta ZELARI_MISSION_MAX_COST / ZELARI_MISSION_MAX_TOKENS più alto, ' +
    'o usa un modello più economico. Stato salvato in .zelari/mission-state.json',
  );
  return state;
}
```

### 5. Cablaggio del costo dallo slice runner

`missionSlice.ts` (`runAgentMissionSlice`) ha già accesso all'`AgentHarness`
ed emette `tool_execution_*`/`message_end`. Due opzioni:

- **Opzione A (semplice):** lo slice runner stima `costTokens` dai `usage`
  dell'ultimo `message_end` e `costUsd` via `calculateCost(model, ...)`, li
  mette in `SliceRunResult`. Non conta tool-call secondari ma è sufficiente
  come guardrail.
- **Opzione B (precisa):** iniettare un `MemberCostTracker` condiviso nel
  deps della missione; lo slice runner lo alimenta con ogni evento. Il loop
  legge `tracker.totalTokens()`. Più preciso ma tocca la signature di più
  funzioni.

**Raccomandata Opzione A** per il primo rilascio (guardrail anti-spesa, non
contabilità esatta); Opzione B come follow-up se serve reporting.

### 6. `MissionState` persistente

Aggiungere a `MissionState` (riga ~26) per osservabilità/resume:

```ts
/** Costo cumulativo (USD) e token al momento dell'ultima persistenza. */
cumulativeCostUsd?: number;
cumulativeTokens?: number;
```

Aggiornarli in `writeMissionState` insieme a `state.iteration`.

## Alternative considerate

- **Cap per-slice invece che per-missione:** scartato. Un singolo council run
  può costare molto legittimamente (design-phase + implementazione); il tetto
  deve misurare la *spesa totale della missione*, non il singolo step.
- **Cap solo a token, senza USD:** scartato. L'utente ragiona in dollari; il
  modulo `modelPricing.ts` esiste apposta. Offrire entrambi (l'utente sceglie).
- **Hard-abort dell'intero CLI invece di `status: 'stopped'`:** scartato per
  coerenza con le altre stop-rule (iteration cap e stall fanno tutte
  `state.status = 'stopped'`/`'stalled'` + handoff state in
  `.zelari/mission-state.json`, non un crash). L'utente può `/resume`.
- **Modello che verifica se stesso come "cost judge":** scartato. Il cap è
  deterministico (somma aritmetica vs. soglia), non richiede un LLM — coerente
  col principio "verifier deterministico > model self-grading".

## Conseguenze

**Positive**
- Terza stop-rule completa il triangolo di sicurezza del loop Zelari:
  l'utente può lasciare una missione incustodita sapendo che il tetto di
  spesa è garantito ("runs while you sleep").
- Allinea zelari-code al vocabolario emergente di "loop engineering" con
  una feature concreta, non nominale.
- `MissionState` diventa auto-documentante sui costi (utile per
  `/council-cost` style reporting futuro).

**Negative / rischi**
- Opzione A sotto-stima il costo reale (ignora tool-call secondari e
  cache-break). Mitigato: è un *guardrail*, non un report finanziario;
  l'utente imposta il tetto con margine.
- Una stima imprecisa potrebbe fermare una missione troppo presto o troppo
  tardi. Mitigato: default `off` → zero regressione per chi non imposta
  le env var.

## TODO

- [ ] Implementare `resolveMaxCost` / `resolveMaxTokens` in `zelariMission.ts`.
- [ ] Estendere `SliceRunResult` e `MissionState` con i campi costo.
- [ ] Cablaggio costo in `runAgentMissionSlice` (`missionSlice.ts`, Opzione A).
- [ ] Stop-check nel `while(true)` di `runZelariMission`.
- [ ] Test unitari (`zelariMission.test.ts`): missione si ferma a tetto USD;
      missione si ferma a tetto token; missione senza env var non si ferma
      (backward compat); `resolveMaxCost`/`resolveMaxTokens` parsing edge case.
- [ ] Documentare le env var in `README.md` (tabella Features) e `docs/GUIDA.md`.
- [ ] Aggiornare `AGENTS.MD` sezione Open Questions / Decisions.
