# Piano di intervento prestazionale — Kraken, tentacoli e lead

> **Data:** 2026-09-10 · **Stato:** proposta di implementazione (non ancora approvata)
> **Ambito:** latenza end-to-end di `zelari-code` in modalità Kraken (grafo e lead+`task` tool) e nei turni del lead, **senza ridurre i gate di qualità**.
> **Vincoli di repo:** commit atomici single-task, nessuna dipendenza pesante nuova, moduli nuovi ≤ 300 LOC, async-first, Zod per gli argomenti tool (cfr. `AGENTS.md`).
> **Gate di build per ogni commit:** `npm run typecheck && npm run test && npm run verify:principles && npm run verify:versions`.

---

## Indice

1. [Diagnosi](#1-diagnosi)
2. [Principi guida e anti-goal](#2-principi-guida-e-anti-goal)
3. [Matrice interventi](#3-matrice-interventi)
4. [Fase 0 — baseline e misurazione](#4-fase-0--baseline-e-misurazione)
5. [Intervento 1 (P0) — Model routing dei tentacoli](#5-intervento-1-p0--model-routing-dei-tentacoli)
6. [Intervento 2 (P0) — Verification pack: parallelo + cache](#6-intervento-2-p0--verification-pack-parallelo--cache)
7. [Intervento 3 (P1) — Executor: serializzazioni e coda di coda](#7-intervento-3-p1--executor-serializzazioni-e-coda-di-coda)
8. [Intervento 4 (P1) — Overhead per-turno](#8-intervento-4-p1--overhead-per-turno)
9. [Intervento 5 (P2) — Provider: timeout e failover](#9-intervento-5-p2--provider-timeout-e-failover)
10. [Quick win operativi (solo env, subito)](#10-quick-win-operativi-solo-env-subito)
11. [Piano di rilascio](#11-piano-di-rilascio)
12. [Piano di test complessivo](#12-piano-di-test-complessivo)
13. [Appendice A — flag env coinvolti](#13-appendice-a--flag-env-coinvolti)
14. [Appendice B — file toccati per intervento](#14-appendice-b--file-toccati-per-intervento)

---

## 1. Diagnosi

Analisi condotta su `main @ 01a85bb`. I colli di bottiglia, in ordine di impatto stimato:

### 1.1 Tutti i tentacoli usano il modello flagship del lead

`resolveKrakenSubModel` (`src/cli/tools/krakenModel.ts:177-230`) prevede:
- auto-pick di un modello economico per `explore`/`verify` (rami `opts.candidates`, righe 218-227);
- pick cross-family per `verify` (rami `opts.familyCandidates`, righe 206-216).

Ma l'unico call-site di produzione chiama la funzione **senza `opts`**:

```ts
// src/cli/toolRegistry.ts:998
const resolvedModel = resolveKrakenSubModel(agent, parentModel);
```

`candidates` e `familyCandidates` sono quindi sempre vuoti → **explore, verify e general girano tutti sul modello del lead** (es. `glm-5.3`). Un tentacolo explore che legge 4 file paga la latenza (e il costo) del flagship, moltiplicato per ogni nodo del grafo. Il routing a tier previsto dal spec (`zelari_desktop_kraken_model_routing_spec.md` §8.2-8.5) esiste, è testato in isolamento, e non è mai cablato.

### 1.2 Il gate strict-done esegue i comandi in sequenza, senza cache, più volte

- `VerificationEngine.evaluate` (`packages/core/src/verification/engine.ts:59-61`) itera i criteri con `for...of` + `await`: `typecheck` → `test` → `build` **sequenziali**, ognuno fino a 10 min (`ZELARI_VERIFY_TIMEOUT_MS`, default 600 000 ms — `src/cli/kraken/nativeVerification.ts:133-137`).
- `NodeShellProvider.exec` (`packages/core/src/runtime/nodeProviders.ts:87-142`) spawna un processo fresco a ogni esecuzione: **nessuna cache** dei risultati.
- Un turno blocked riesegue **tutto** una seconda volta dopo il repair pass (`src/cli/headless/runOneTurn.ts:796`); la mission riesegue il gate una terza volta a fine run (`src/cli/runHeadless.ts:1529`).
- Ogni `general` genera automaticamente un tentacolo `verify` = un intero sub-agent LLM multi-turno (`src/cli/tools/taskTool.ts:373-503`; nel grafo: nodo auto-iniettato, `src/cli/kraken/planner.ts:846-859`), con rework+reverify su FAIL (budget 1, `src/cli/kraken/executor.ts:188-195`).

### 1.3 Serializzazioni nell'executor

| Punto | Riferimento | Effetto |
|---|---|---|
| Merge finale sequenziale (squash in for-loop) | `src/cli/kraken/executor.ts:1499-1524` | barriera finale; per design "Correction 4" (niente merge concorrenti sullo stesso HEAD) — **non si tocca** |
| Scope non dichiarato = wildcard `**` | `src/cli/kraken/fileOwnership.ts:95-101` | writer sovrapposti/non dichiarati completamente serializzati; escape solo con `ZELARI_KRAKEN_WORKTREE=auto` (opt-in, `executor.ts:934-975`) |
| Lifecycle worktree: ~8-10 subprocess git per writer, nessun riuso | `src/cli/kraken/krakenWorktree.ts:99-283` | su Windows il checkout copia l'albero e può dominare i task corti |
| Radio: `appendFileSync` su ogni evento di ogni tentacolo | `src/cli/tools/krakenRadio.ts:138` | blocca l'event loop con N tentacoli concurrently |
| `linkMemoryGraph`: `await memory.connect` per edge + consolidate, sequenziali, a fine run | `src/cli/kraken/executor.ts:1740-1792` | tail latency dopo la convergenza |
| `memoryService.remember` awaited sul percorso critico del tentacolo | `src/cli/tools/taskTool.ts:1239-1269` | fail-open ma bloccante |

### 1.4 Overhead per-turno (pesa sul lead e sulle sessioni lunghe)

- **O(n²) sulla sessione**: `readSessionLog` (`packages/core/src/session/replay.ts:40-92`) rilegge e Zod-parsa l'intero `events.jsonl` a ogni lettura, e viene chiamato 2-8 volte per turno (replay, derive, compaction snapshot + re-derive, steer del task-contract su ogni `user.message` — `src/cli/sessionSpine.ts:279, 490-508, 515-522, 701-725`; conteggio evidence — `src/cli/headlessSpine.ts:121-136`). Nessun cursore incrementale.
- **O(n²) nel turno (solo TUI)**: a ogni round-trip del tool loop, `createRoutedRequestSnapshot` fa `structuredClone` ×2 + `stableStringify` ×2 + `JSON.stringify` dell'intera richiesta (`packages/core/src/core/requestSnapshot.ts:113-154`, `packages/core/src/core/contextGrowth.ts:79-83`) — centinaia di KB serializzati 3 volte per chiamata.
- **LLM compaction ON di default** (`ZELARI_LLM_COMPACT`, `src/cli/budget/llmCompact.ts:54-59`): a ≥85% del budget aggiunge una chiamata LLM **bloccante** dentro `buildModelContext` prima della chiamata principale.
- **Memory**: la TUI ricostruisce worker SQLite + import legacy a ogni turno (`src/cli/hooks/useChatTurn.ts:332`); `importLegacyMemoryLog` fa una query SQL RPC **per riga** del log legacy anche quando è già tutto importato (`src/cli/memory/legacyImport.ts:50-63`).

### 1.5 Provider

- First-token idle default **10 minuti** (`ZELARI_PROVIDER_FIRST_TOKEN_IDLE_MS`, `src/cli/provider/openai-compatible.ts:86-90`): un endpoint appeso congela un turno 10 min prima di fallire.
- Il failover cross-provider esiste ma è cablato **solo nella TUI** (`src/cli/hooks/useChatTurn.ts:449-476`); headless e tentacoli non ne hanno.
- Il planner del grafo è una completion **non-streaming bloccante** da 300 s davanti a tutto il grafo (`src/cli/kraken/planner.ts:65, 649-669`); il modello è sempre quello del lead salvo `ZELARI_KRAKEN_PLANNER_MODEL`.

---

## 2. Principi guida e anti-goal

**Principio centrale: la lentezza sta nell'esecuzione, non nei gate.** Si cambia *quando/come/dove* si esegue il lavoro, non *quanto* si verifica.

### Cosa NON si tocca (anti-goal)

1. ❌ `ZELARI_STRICT_DONE`, `ZELARI_MISSION_STRICT` restano ON di default. Nessun indebolimento di `CompletionPolicy` (`PASS|REPAIR_REQUIRED|BLOCKED`), `unknown ≠ pass`, evidence anchoring (F3), proof persistence `required`.
2. ❌ Il verify pack resta ON di default (`ZELARI_VERIFY_PACK`). Parallelismo e cache non cambiano *verdicts*: stessa comando, stessa attesa exit code, stessa evidenza (marcata `cached` quando riusata).
3. ❌ Budget di repair (1) e rework (1) invariati. I tentacoli `verify` restano: si cambia solo il *modello* con cui girano (routing), non la loro esistenza.
4. ❌ Merge sequenziali (Correction 4, `executor.ts:19-21`). Nessun merge concorrente sullo stesso HEAD padre.
5. ❌ Nessuna dipendenza nuova (niente tokenizer reali: restiamo su `chars/4` + memoizzazione; niente lock library: promise-chain esistenti).
6. ❌ `general` (writer) continua a usare il modello forte: l'auto-pick economico è per `explore`/`verify` only, per design (`krakenModel.ts:222-227`).

### Proprietà di invarianza da dimostrare nei test

Per ogni intervento, i test devono dimostrare che:
- i verdict del gate sono identici (stesso input → stesso `status` per criterio);
- l'evidenza resta ancorata (EvidenceRef.seq presente, digest invariato o marcato `cached`);
- ogni nuovo comportamento ha un kill-switch env che ripristina il comportamento precedente.

---

## 3. Matrice interventi

| # | Intervento | Priorità | Sforzo | Rischio | Guadagno atteso* | Kill-switch |
|---|---|---|---|---|---|---|
| 1 | Cablare i candidates in `resolveKrakenSubModel` | **P0** | S (½ g) | Basso | −30/−60% wall-clock grafo (dipende dal gap flagship↔cheap) | `ZELARI_KRAKEN_AUTO_MODEL=0`, `ZELARI_KRAKEN_CROSS_MODEL=0` |
| 2a | Criteri comando del pack in parallelo | **P0** | S (½ g) | Medio-basso | gate 3 comandi: ~1/2.5 del wall-clock | `ZELARI_VERIFY_PARALLEL=0` |
| 2b | Cache risultati comandi (tree-unchanged) | **P0** | M (1 g) | Basso | elimina 2ª/3ª esecuzione (repair, mission-end) | `ZELARI_VERIFY_CACHE=0` |
| 3a | Radio async (promise-chain) | P1 | XS | Basso | sblocca event loop con N tentacoli | `ZELARI_KRAKEN_RADIO=sync` (opzionale) |
| 3b | `linkMemoryGraph` parallelizzato | P1 | XS | Basso | taglia tail latency post-run | — (fail-open già presente) |
| 3c | Worktree: memo root + prune batchizzato | P1 | S | Basso | −2-4 subprocess per writer | `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` |
| 3d | Promuovere `WORKTREE=auto` a default | P1 (decisione) | XS codice, M validate | Medio | writer sovrapposti in parallelo | `ZELARI_KRAKEN_WORKTREE=off` |
| 4a | Replay incrementale spine | P1 | M (1-2 g) | Medio | turni lunghi: da 2-8 letture full a 1 | `ZELARI_SPINE_REPLAY_CACHE=0` |
| 4b | requestSnapshot `lite` (TUI) | P1/P2 | M | Medio (audit) | −3 serializzazioni/round-trip | `ZELARI_REQUEST_SNAPSHOT=full` |
| 4c | Legacy memory import: marker + batch | P1 | S | Basso | elimina N query/turno | cancellare il marker |
| 5a | Doc/tuning first-token idle | P2 | XS | — | evita stalli 10 min (config) | env per-call |
| 5b | Failover su headless/kraken | P2 | M | Medio | resilienza, non solo latenza | `ZELARI_HEADLESS_FAILOVER=0` |

\* Stime da validare in Fase 0; nessun numero è una promessa.

---

## 4. Fase 0 — baseline e misurazione

**Obbligatoriamente prima del primo commit di codice.** Senza baseline non si può dimostrare né il guadagno né la non-regressione.

### 4.1 Strumenti già presenti (zero codice nuovo)

- `durationMs` per nodo nel digest finale (`src/cli/kraken/graphStatus.ts:98-141`, `KrakenExecutionSummary` — `executor.ts:480`).
- Radio JSONL: `.zelari/kraken/radio/*.jsonl` con `durationMs` per ogni fase (`src/cli/tools/krakenRadio.ts`).
- Workbench markdown: durate/verdict/modello per nodo (`src/cli/kraken/workbench.ts`).
- `VerificationResult.durationMs` per comando nei proof (`.zelari/completion-proof.json`).

### 4.2 Protocollo

1. Task benchmark fisso, eseguito su una copia pulita di un repo di riferimento (candidato: questo repo, task tipo "aggiungi un builtin tool con test", 3 writer + 2 explore).
2. `N=3` run per configurazione; si riporta mediana di: wall-clock totale, somma `durationMs` per kind di nodo, durata gate (somma `durationMs` dei criteri), numero round-trip provider (dal radio).
3. Configurazioni misurate: (a) baseline; (b) solo env quick-win (§10); (c) dopo ogni intervento.
4. Script di raccolta opzionale `scripts/perf-bench.mjs` (nuovo, ≤ 150 LOC): legge radio + proof di una run e stampa la tabella. Non bloccante per la Fase 0 manuale.

### 4.3 Criteri di uscita della Fase 0

- Tabella baseline con mediana e deviazione per metrica.
- Confronto (a) vs (b): quantifica quanto recuperano i soli env var → stabilisce l'ordine reale degli interventi (se (b) già recupera molto, il 3d/5a salgono di priorità).

---

## 5. Intervento 1 (P0) — Model routing dei tentacoli

### 5.1 Obiettivo

Riattivare il routing già progettato (K5 + P0.6): `explore`/`verify` su modello economico/auto-pick, `verify` cross-family quando disponibile, `general` invariato sul modello del lead.

### 5.2 Modifica

**File:** `src/cli/toolRegistry.ts` (call-site ~`998`), dentro `createSubAgentContextFactory`. Il factory è già `async`: si caricano i candidates dalla discovery cache (`~/.zelari-code/models.json`, cache 6 h — `src/cli/modelDiscovery.ts`).

```ts
// src/cli/toolRegistry.ts — dentro il factory, dopo la risoluzione di cfg
const { resolveKrakenSubModel, parseQualifiedModelRef } = await import('./tools/krakenModel.js');
const parentModel = modelOverride || cfg.model;

// PERF-1: discovery candidates per l'auto-pick (explore/verify) e il
// cross-family verify. Memoizzati a livello di modulo su mtime del file.
const candidates = discoveredModelIds(cfg.providerId);          // string[]
const familyCandidates = discoveredFamilyCandidates();          // {provider, model}[]
const resolvedModel = resolveKrakenSubModel(agent, parentModel, process.env, {
  provider: cfg.providerId,
  candidates,
  familyCandidates,
});
```

Nuovo modulo di supporto **`src/cli/tools/krakenModelCandidates.ts`** (≤ 120 LOC):

```ts
import { getCachedModels, loadModelsRegistry } from '../modelDiscovery.js';

let memo: { mtimeMs: number; candidates: string[]; family: {provider: string; model: string}[] } | null = null;

export function discoveredModelCandidates(providerId: string | undefined): {
  candidates: string[];
  familyCandidates: { provider: string; model: string }[];
} {
  // 1. loadModelsRegistry() + stat mtime; se memo valido → return memo.
  // 2. Costruisce:
  //    candidates  = modelli del provider attivo (entry.models.map(m => m.id))
  //    family      = tutti i provider: Object.entries(registry.providers)
  //                    .flatMap(([provider, entry]) =>
  //                    entry.models.map(m => ({ provider, model: m.id })))
  // 3._registry shape da adattare a loadModelsRegistry() effettiva
  //    (vedi modelDiscovery.ts:62 ModelsRegistry); fallisce aperto su
  //    registry mancante → { candidates: [], familyCandidates: [] }.
}
```

Note di progetto:

- **Memoizzazione**: lettura + `stat` una sola volta per processo (al primo spawn); il file è piccolo, ma con 10 tentacoli evita 10 letture+parse.
- **Fail-open invariato**: niente cache discovery → candidates vuoti → comportamento identico a oggi (modello del lead). Nessun fallimento nuovo possibile.
- **Graceful degradation già esistente**: se il modello routed 404 (non autorizzato), il tentacle retry-una-volta sul parent (`src/cli/tools/taskTool.ts:1096-1126`).
- **Cross-family**: il ref qualificato `provider/model` viene già gestito dal call-site (`toolRegistry.ts:1005-1015` → `providerConfigFor`); provider senza credenziali → si mantiene l'id raw → 404 → fallback parent. Documentare questo percorso nel test.

### 5.3 Documentazione operativa (stessa commit o commit separato)

In `docs/GUIDA.md` (sezione routing Kraken, ~linea 1529): promuovere a "consigliata" la configurazione:

```
ZELARI_KRAKEN_PLANNER_MODEL=<modello veloce non-reasoning>   # es. glm-4.7-air / grok-3-mini
ZELARI_KRAKEN_EXPLORE_MODEL=<cheap>                           # opzionale se auto-pick attivo
ZELARI_KRAKEN_VERIFY_MODEL=<provider/modello cross-family>    # opzionale
```

### 5.4 Test

- **Unit** (`src/cli/tools/krakenModelCandidates.test.ts`): memo su mtime; registry mancante → vuoto; shape family corretta.
- **Unit** (`toolRegistry` o test di integrazione del factory): con candidates contenenti un id cheap, `explore` risolve cheap, `general` risolve parent, `verify` risolve cross-family quando presente un provider di famiglia diversa; con `ZELARI_KRAKEN_AUTO_MODEL=0` → sempre parent.
- **Regressione**: i test esistenti di `krakenModel.test.ts` non cambiano (la funzione non viene toccata).

### 5.5 Accettazione

- [ ] Run benchmark Fase 0: `explore`/`verify` girano su modello ≠ lead quando la discovery ha candidates cheap (verificato dal workbench md, colonna modello).
- [ ] `general` invariato sul modello del lead.
- [ ] Con `ZELARI_KRAKEN_AUTO_MODEL=0` l'output del routing è bit-identico a prima.

### 5.6 Rischi

| Rischio | Mitigazione |
|---|---|
| Un cheap model peggiora la qualità della verifica | `verify` ha fallback rework + gate deterministico a valle (pack) che non dipende dal modello del tentacolo; kill-switch immediato; cross-family preferito dal routing quando disponibile |
| Discovery cache stalta/scaduta | Fail-open su parent (comportamento odierno) |
| Modellazione `ModelsRegistry` diversa dallo sketch | Il modulo è isolato: un solo adattamento, testato |

---

## 6. Intervento 2 (P0) — Verification pack: parallelo + cache

### 6.1 Obiettivo

Stessi verdict, stessa evidenza, esecuzione più rapida: (a) i tre comandi del pack in parallelo; (b) riuso del risultato quando l'albero non è cambiato tra due valutazioni nello stesso processo.

### 6.2a Parallelismo — `packages/core/src/verification/engine.ts`

Sostituire il loop sequenziale in `evaluate` (righe 58-61) con esecuzione concorrente limitata, **preservando l'ordine dell'array risultati** (il payload `verification.run` e i consumer assumono l'ordine dei criteri):

```ts
async evaluate(
  criteria: readonly Criterion[],
  context: { packId?: string; scope?: ScopeAnalysisInput } = {},
): Promise<VerificationResult[]> {
  const limit = this.options.commandConcurrency ?? defaultCommandConcurrency(); // env ZELARI_VERIFY_CONCURRENCY, default 3
  // mappa indice→promise, eseguite con semaforo interno (nessuna dipendenza: counter-based)
  const settled = await runWithLimit(criteria, limit, (c) => this.evaluateOne(c, context.scope));
  // `settled[i]` corrisponde a criteria[i]: l'ordine dei risultati è preservato,
  // cambia solo l'ordine di emissione degli eventi verification.evidence (seq
  // interleaved) — ammissibile: l'ancoraggio è per-seq, non per-ordine.
  // ... emissione verification.run invariata
}
```

Dettagli:

- **Semantica dei verdicts invariata**: ogni criterio valuta lo stesso comando con lo stesso `expectExit`/`expectStdoutIncludes`. Il parallelismo non cambia la logica di status.
- **Sicurezza della concorrenza**: l'ordine attuale `typecheck → test → build` implica già che `test` non dipende dagli output di `build` (altrimenti l'ordine odierno sarebbe rotto). Il rischio residuo è interferenza di scrittura (es. `test` che fa build internamente mentre `build` scrive dist): il fallimento eventuale è **fail-closed** (exit ≠ 0 → `fail` → repair), mai falsi PASS. Default ON con kill-switch `ZELARI_VERIFY_PARALLEL=0`; i repo il cui `test` dipende dalla build lo documentano in GUIDA.
- **Eventi evidence interleaved**: `emitEvidence` è chiamato da criteri concorrenti; la writer-chain della spine già serializza le append. L'ancoraggio EvidenceRef.seq è per evento, ordine-indipendente. Verificare che nessun test assuma l'ordine lineare degli eventi evidence (aggiornarli se necessario, con nota nella commit).
- **Nuova opzione** `commandConcurrency` in `VerificationEngineOptions` + helper `runWithLimit` locale (~20 LOC, zero dip).

### 6.2b Cache — decoratore `CachedShellProvider`

**Nuovo modulo** `src/cli/kraken/cachedShell.ts` (≤ 200 LOC). Decoratore di `ShellProvider` iniettato ai siti di costruzione del motore del gate (`src/cli/kraken/nativeVerification.ts:191-208` per il pack; `src/cli/kraken/contractCompiler.ts:213` per i criteri contrattuali — **una sola istanza condivisa per valutazione/turno**, così pack e contract condividono la cache).

Chiave di cache:

```ts
const key = sha256(JSON.stringify({
  command,                              // stringa esatta
  cwd: opts?.cwd ?? '',                 // default = root workspace
  timeoutMs: opts?.timeoutMs ?? null,   // cambio di budget → nuovo esperimento
  tree: await treeState(cwd),           // 'HEAD:<sha>|<sha256(git status --porcelain)>'
}));
```

- `treeState(cwd)`: `git rev-parse HEAD` + `git status --porcelain` (2 subprocess, ~100-300 ms su Windows — irrilevante rispetto a comandi da minuti). Memoizzata con TTL 5 s per non ripetere le 2 chiamate per ogni criterio nella stessa valutazione.
- **Politica conservativa**: `git status --porcelain` copre modifiche tracked + file untracked → qualsiasi scrittura di un tentacolo/repair invalida. La cache colpisce solo quando l'albero è davvero immutato tra due valutazioni (es. repair pass senza diff efficace, o fine mission).
- **Memoria only, LRU 32 voci**: copre i casi stessi-processo (2ª valutazione post-repair, 3ª a fine mission). Nessuna persistenza su disco in v1 (evita rischi di stale-cross-processo).
- **Evidenza onesta**: estendere `ShellResult` (`packages/core/src/runtime/providers.ts`) con `cached?: boolean` opzionale. Il decoratore lo setta; `evalCommand` (engine.ts:165+) lo propaga:
  - nell'evento `verification.evidence`: campo `cached: true`;
  - nel `detail` del `VerificationResult`: suffisso `"(cached — tree unchanged since last run)"`;
  - `durationMs` ~0 (tempo reale della cache hit).
  Il digest dello stdout resta identico (stesso output) → l'ancoraggio F3 resta valido.

Kill-switch: `ZELARI_VERIFY_CACHE=0` (default ON).

### 6.3 Cosa NON cambia

- Ordine degli slot nel `verification.run` (results in ordine criteri).
- I contratti `Verify:` del TaskContract restano non-gated su `ZELARI_VERIFY_PACK` (`contractCompiler.ts:197-203`) e ora passano dallo stesso engine parallelizzato + cache condivisa.
- Il repair pass e la exit-4 restano esattamente come sono.

### 6.4 Test

- **Engine parallelo** (`engine.test.ts` core): fake shell con delay 100 ms ×3 criteri → wall-clock < 250 ms; risultati in ordine; `ZELARI_VERIFY_PARALLEL=0` → wall-clock ≥ 300 ms (sequenziale).
- **Concorrenza limitata**: 6 criteri con `commandConcurrency: 2` → max 2 invocazioni simultanee (tracker nel fake shell).
- **Cache** (`cachedShell.test.ts`): stesso comando+tree → shell invoked once, `cached: true` nella 2ª risposta; scrittura file (tree change) → re-invoked; LRU eviction; `ZELARI_VERIFY_CACHE=0` bypassa.
- **Invarianza verdicts**: property test — con fake shell deterministico, `evaluate` sequenziale vs parallelo vs cached producono stessi `status` per criterio e stessi digest.
- **Integrazione gate**: run blocked → repair senza cambiamenti → 2ª valutazione riusa i risultati (assert: shell exec count invariato, exit 4 invariato se ancora blocked).

### 6.5 Accettazione

- [ ] Gate verde con 3 comandi: wall-clock ≈ max(durate) invece di somma(durate) nel benchmark.
- [ ] Run blocked+repair senza delta effettivi: 2ª valutazione < 2 s (solo treeState + spine).
- [ ] Proof JSON mostra `cached: true` sulle evidenze riusate — tracciabilità conservata.

---

## 7. Intervento 3 (P1) — Executor: serializzazioni e coda di coda

### 7.1 Radio asincrona (3a)

**File:** `src/cli/tools/krakenRadio.ts:138`. Sostituire `appendFileSync` con promise-chain (identica alla pattern della spine writer, `packages/core/src/session/writer.ts:223-241`): ordine preservato per processo, event loop libero.

```ts
let radioChain: Promise<void> = Promise.resolve();
function appendLine(file: string, line: string): Promise<void> {
  radioChain = radioChain.then(() => fs.appendFile(file, line)).catch(() => {}); // fail-open, come oggi
  return radioChain;
}
```

Il radio è pura osservabilità: nessun consumer dipende dalla durabilità sincrona. **Test:** 100 emit concorrenti → righe in ordine e complete; nessun `appendFileSync` residuo (grep test o snapshot).

### 7.2 Tail memory-graph parallelizzato (3b)

**File:** `src/cli/kraken/executor.ts:1740-1792`. `memory.connect` per edge è indipendente per definizione (grafo): parallelizzare con concorrenza limitata 8; `consolidate` resta awaited (una sola chiamata), entrambi fail-open come oggi.

```ts
await runWithLimit(edges, 8, (e) =>
  memory.connect(e.from, e.relation, e.to).catch(() => undefined));
await memory.consolidate().catch(() => undefined);
```

(Riusare l'helper `runWithLimit` dell'Intervento 2, spostandolo in un modulo condiviso `src/cli/asyncLimit.ts` o in core se serve al engine — deciso in implementazione, ≤ 30 LOC.)

### 7.3 Worktree: micro-ottimizzazioni lifecycle (3c)

**File:** `src/cli/kraken/krakenWorktree.ts`.

1. **Memoizzare `git rev-parse --show-toplevel`** per processo (righe 103-107): è costante per run; oggi 2 subprocess sprecati per ogni writer.
2. **Batch del cleanup a fine run**: raccogliere i branch names rimossi durante la run ed eseguire un solo `worktree prune` + `git branch -D <list>` alla fine (`executor.ts`, fase post-merge accanto a `saveGraphSnapshot`). Il `worktree remove --force` per singolo writer resta eager (libera il filesystem). Kill-switch `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` per tornare al comportamento attuale.

**Non in scope v1** (documentare come futuro): pool/riuso worktree tra writer sequenzali dello stesso scope.

### 7.4 Promozione `ZELARI_KRAKEN_WORKTREE=auto` a default (3d) — **decisione**

Stato attuale: default `off` → writer sovrapposti serializzati da `arbitrateAdmission` (`fileOwnership.ts:195-214`). Con `auto`, i writer con overlap < 0.75 vengono rescue-ati su worktree isolati e parallelizzati (`executor.ts:934-975`, soglie in `worktreeScheduling.ts:74/82`).

Proposta di rollout graduale:

1. **2.38**: default invariato; `auto` documentato in GUIDA come "consigliato su repo medio-grandi" + misurato in benchmark Fase 0 (config (b)).
2. **Dogfood**: eval + uso interno con `auto` per ≥ 1 settimana; metriche di interesse: tasso merge-conflict nei merge node, wall-clock writer-total vs wall-clock graph-total.
3. **2.39**: se conflict-rate invariato e wall-clock migliorato → default `auto`, opt-out `ZELARI_KRAKEN_WORKTREE=off`.

Rischio specifico Windows: costo checkout completo per worktree — mitigato da 7.3 e dalla misura Fase 0 (se il costo checkout > guadagno parallelismo sui task corti, `auto` resta opt-in: la soglia 0.75 di overlap già seleziona solo i casi in cui vale la pena).

### 7.5 Test

- 7.1: vedi sopra.
- 7.2: K edge con fake memory lenta 50 ms → wall-clock ≈ ceil(K/8)×50 ms, non K×50; fallimenti singoli non propagano.
- 7.3: due cleanup → un solo `prune` spawn (fake git o shell spy); con `eager` → comportamento attuale.
- 7.4: test esistenti di `worktreeScheduling.test.ts` + `strictDefaults.test.ts` aggiornati alla nuova default solo al momento del flip (commit separata, revertabile).

---

## 8. Intervento 4 (P1) — Overhead per-turno

### 8.1 Replay incrementale della spine (4a) — il pezzo grosso

**Problema:** `readSessionLog` (`packages/core/src/session/replay.ts:40-92`) fa `readFile` intero + `JSON.parse` + Zod `safeParse` **per riga** a ogni chiamata; 2-8 chiamate per turno; a fine sessione lunga è O(n²) netto.

**Design:** nuovo modulo `packages/core/src/session/replayCache.ts` (≤ 250 LOC):

```ts
export interface ReplayCacheEntry {
  byteSize: number;          // byte consumati (solo righe COMPLETE, con \n finale)
  mtimeMs: number;
  events: SessionEventEnvelope[];
  issues: ReplayIssue[];
  expectedSeq: number;
  partial: string;           // coda senza \n finale (writer crash mid-line)
}

export class SessionLogCache {
  private entries = new Map<string, ReplayCacheEntry>();
  async read(filePath: string): Promise<ReplayReport>;  // sostituisce readSessionLog nei call-site caldi
}

export async function readSessionLogCached(
  filePath: string,
  cache: SessionLogCache,
): Promise<ReplayReport>;
```

Algoritmo:

1. `stat` del file. Se cached e `size >= cached.byteSize`: leggere **solo** i byte da `cached.byteSize` (`filehandle.read` con position), prepend della `partial` salvata, parsare solo le nuove righe complete, estendere `events`/`issues`/`expectedSeq`.
2. Se `size < cached.byteSize` (rotazione/troncamento) o mtime regredita: full re-read (percorso attuale).
3. La coda senza `\n` finale resta in `partial` e **non** avanza `byteSize` — una riga troncata da crash del writer non viene mai contata due volte né persa.
4. Il `ReplayReport` restituito è un oggetto fresco (i consumer possono mutarlo); gli eventi condivisi sono treat-as-immutable (già contratto della spine).

**Cablaggio** (una istanza cache per sessione, non globale):
- `src/cli/sessionSpine.ts`: siti 279 (adopt), 490-497 (derive), 500-508 (compaction snapshot + re-derive → con la cache il doppione costa ~0), 515-522 (lastVerificationRun), 701-725 (steer task-contract).
- `src/cli/headlessSpine.ts`: 121-136 (countVerificationEvidence), 323 (seed).
- `readSessionLog` pubblica resta intatta per compatibilità e per i test.

**Kill-switch:** `ZELARI_SPINE_REPLAY_CACHE=0` (default ON dopo dogfood; primo merge dietro flag ON in eval, OFF default, flip in commit successiva).

**Test:** file cresciuto → solo i byte nuovi letti (spy su fs.read/readFile); troncamento → full re-read; riga troncata finale → riparsata alla lettura successiva dopo completamento; seq-gap/duplicate preservati; equivalenza bit-per-bit del `ReplayReport` vs `readSessionLog` su log generati (property test con writer reale).

**Nota onestà:** `deriveMessages` resta O(eventi) per chiamata — l'intervento elimina il costo di parse/IO (la parte dominante), non la proiezione. La proiezione incrementale è un follow-up esplicitamente escluso da v1.

### 8.2 requestSnapshot `lite` (4b) — TUI lead

**Problema:** per round-trip, `structuredClone` ×2 + `stableStringify` ×2 + `JSON.stringify` dell'intera richiesta (`requestSnapshot.ts:113-154`; `contextGrowth.ts:79-83`). Cablato solo nella TUI (`useChatTurn.ts:864`).

**Design:** modalità `ZELARI_REQUEST_SNAPSHOT=full|lite|off` (default `full` in 2.38; flip a `lite` dopo dogfood):

- `lite`:
  - niente `structuredClone`: si costruiscono shallow-copy (array + oggetti di primo livello); i messaggi nel loop non vengono mutati dopo l'append (verificare con test di freeze).
  - **header fingerprint calcolato una sola volta per harness run** (memo su reference identity dell'array tools + hash della system string) — in un turno tools+system sono fissi dopo lo start.
  - `stableStringify` dell'intera richiesta diventa **lazy**: getter `Object.defineProperty` che stringifica solo se un consumer accede al digest. `requestMeter` (anchoring) tocca i `messages`, non il digest completo → costo evitato nel percorso caldo.
- `off`: snapshot disattivato (solo metering base). Documentare che `off` riduce l'audit trail della TUI — per questo il default resta `full` finché non misurato.

**Test:** parità del digest tra `full` e `lite` su stessa richiesta (property test); lazy digest calcolato correttamente al primo accesso; snapshot store funzionante in `lite`.

### 8.3 Compaction (4c) — config + beneficio indiretto

- Nessun cambio di codice in v1: documentare `ZELARI_COMPACT_MODEL` (già esistente, `llmCompact.ts:54-65`) puntato su un modello cheap per la summary bloccante; il prefix-replay per cache-reuse provider è già implementato.
- Il beneficio automatico: la doppia lettura full-log attorno alla compaction (`modelContextBuilder.ts:186-195`) collassa grazie a 8.1.

### 8.4 Memory import legacy (4c/4d)

**File:** `src/cli/memory/legacyImport.ts`, backend SQLite.

1. **Marker di import completato**: dopo un pass completo in cui ogni riga è `imported` o `skipped` (le `corrupt` sono tollerate — resteranno sempre corrupt), scrivere un marker (riga in tabella meta del backend, o file `legacy-import-done` accanto al db con `{found, at}`). Ai boot successivi: marker presente → **non leggere affatto** `log.jsonl`. Rimozione marker = re-import manuale.
2. **Batch `hasImport`**: aggiungere `hasImports(ids: string[]): Promise<Set<string>>` al backend (query `IN` chunked da 500) per il primo import — sostituisce la RPC per riga. Zod/schema invariati (API interna).

**Test:** secondo boot con marker → zero query sul log (spy); import reale di un log sintetico → conteggi identici all'implementazione attuale; marker mancante → comportamento attuale.

**Non in scope v1** (documentare): worker SQLite persistente tra turni della TUI (`useChatTurn.ts:332` ricostruisce lo stack per turno) — refactor di lifecycle, P2 futuro.

---

## 9. Intervento 5 (P2) — Provider: timeout e failover

### 9.1 First-token idle (5a)

Default attuale 600 000 ms (`ZELARI_PROVIDER_FIRST_TOKEN_IDLE_MS`, `openai-compatible.ts:86-90`): pensato per reasoning model che stanno zitti minuti prima di `reasoning_content` (nota nel codice, righe 57-59).

**Azione v1: solo documentazione** in GUIDA (profilo consigliato: 120 000-180 000 ms per provider non-reasoning; grok/GLM-thinking tengono 600 000 — i profile Grok hanno già i propri override, `capabilities.ts:99-131`). Un cambio di default globale penalizzerebbe proprio i reasoning model che lo richiedono: decisione rinviata a dati Fase 0 (metrica: frequenza first-token > 120 s per provider).

### 9.2 Failover su headless/kraken (5b)

**Problema:** `crossProviderFailover.ts` + `providerFailover.ts` sono cablati solo nella TUI (`useChatTurn.ts:449-476`); headless (`runHeadless.ts:185-204`) e tentacoli non hanno failover.

**Design (opt-in):** `ZELARI_HEADLESS_FAILOVER=1`:
1. Nella costruzione dello stream headless: risolvere il failover target una volta per run (`resolveFailoverStream` — motivi: `disabled|unset|unknown|same-as-primary|missing-key|resolved`).
2. Al primo evento di errore transiente dal primario (stessa semantica della TUI: single-shot, nessun retry del primario), swap sullo stream di failover per il round-trip corrente.
3. Tentacoli: il retry-una-volta-esistente su 404 model (`taskTool.ts:1096-1126`) resta; il failover si applica al transport error dello stream del tentacolo con la stessa meccanica.
4. **Audit**: evento radio/spine `provider.failover` con motivo — essenziale per non mascherare degradazioni.

**Test:** stream primario che emette errore transiente al primo chunk → la risposta arriva dal failover; failover non configurato → comportamento attuale; errore non-transiente → nessuno swap.

---

## 10. Quick win operativi (solo env, subito)

Configurazione consigliata **da applicare oggi, zero codice** — è anche la config (b) della Fase 0:

```bash
# Routing tentacoli (il fix più importante disponibile SENZA codice)
export ZELARI_KRAKEN_PLANNER_MODEL="glm/glm-4.7-air"          # veloce, non-reasoning (qualificato o id semplice)
export ZELARI_KRAKEN_EXPLORE_MODEL="glm/glm-4.7-air"          # explore non serve il flagship
export ZELARI_KRAKEN_VERIFY_MODEL="grok/grok-3-mini"          # verify cross-family se hai 2 provider

# Writer sovrapposti in parallelo (scope rescue via worktree)
export ZELARI_KRAKEN_WORKTREE=auto

# Compaction su modello cheap (chiamata bloccante a ≥85% budget)
export ZELARI_COMPACT_MODEL="glm/glm-4.7-air"

# Gate: budget per comando più stretti dove il repo è veloce
export ZELARI_VERIFY_TIMEOUT_MS=300000                        # 5 min invece di 10
# Comandi incrementali (esempio questo repo):
# export ZELARI_VERIFY_TYPECHECK_CMD="tsc --noEmit -p tsconfig.json"

# Concorrenza grafo (default 12 — alzare solo se il provider regge)
# export ZELARI_KRAKEN_MAX_PARALLEL=12
```

NOTA: senza l'Intervento 1, `EXPLORE/VERIFY_MODEL` espliciti restano l'**unico** modo per avere tentacoli economici — l'auto-pick è codice morto al call-site attuale.

---

## 11. Piano di rilascio

Convenzioni repo: **commit atomiche single-task**, ogni commit con test verdi (`npm run typecheck && npm run test && npm run verify:principles && npm run verify:versions`), CHANGELOG aggiornato.

| Ordine | Deliverable | Target |
|---|---|---|
| 0 | Baseline benchmark + script raccolta | subito |
| 1 | Int1 routing (codice + test + GUIDA) | 2.38.0 |
| 2 | Int2a engine parallelo | 2.38.0 |
| 3 | Int2b cached shell + flag | 2.38.0 |
| 4 | Int3a radio async + Int3b memory tail (commits separate) | 2.38.x |
| 5 | Int4a replay cache (flag ON in eval, flip default dopo) | 2.38.x |
| 6 | Int4c memory import marker+batch | 2.38.x |
| 7 | Int3c worktree micro-opt | 2.38.x |
| 8 | Int4b snapshot lite (default `full`, dogfood `lite`) | 2.39 |
| 9 | Int3d decisione default `WORKTREE=auto` (con dati) | 2.39 |
| 10 | Int5b failover headless opt-in | 2.39 |

Ogni deliverable è autonomamente revertabile (flag env o commit revert). Nessun deliverato dipende da un altro per la correttezza — solo Int 2b condivide l'helper `runWithLimit` con 3b (estratto nella commit di 2a).

---

## 12. Piano di test complessivo

### Per-commit (minimo)

```
npm run typecheck
npm run test            # vitest run
npm run verify:principles
npm run verify:versions
```

### Suite di non-regressione qualità (ogni deliverable P0/P1)

1. **Gate invariance**: stessa log di input → stessi verdict per criterio, stesso `CompletionPolicy`, stesse exit code (0/2/3/4) — property test con fake shell deterministico.
2. **Evidence anchoring**: ogni EvidenceRef riusato ha `seq` valido + `cached: true` nel payload spine; digest invariati.
3. **Routing**: matrice explore/verify/general × (candidates presenti/assenti/auto-model off) → modello atteso.
4. **Spine**: replay incrementale vs full su log con gap/duplicate/corrupt/torn-line → `ReplayReport` equivalenti.
5. **Eval esistenti** (`eval/`, `npm run eval` se cablato): nessuna regressione nei benchmark qualità esistenti — è la prova del requisito "senza influire sulla qualità".

### Benchmark di latenza (per deliverable, protocollo §4)

Mediana N=3, confronto con baseline: wall-clock totale, wall-clock gate, somma durate per kind nodo, round-trip provider. Un deliverable che non migliora la sua metrica target viene tenuto solo se ha altro valore (resilienza/audit) e comunque documentato.

---

## 13. Appendice A — flag env coinvolti

### Nuovi (introdotti da questo piano)

| Flag | Default | Intervento | Significato |
|---|---|---|---|
| `ZELARI_VERIFY_PARALLEL` | `1` | 2a | `0` = criteri comando sequenziali (comportamento pre-2.38) |
| `ZELARI_VERIFY_CONCURRENCY` | `3` | 2a | max comandi concurrently nel gate |
| `ZELARI_VERIFY_CACHE` | `1` | 2b | `0` = nessun riuso risultati comandi |
| `ZELARI_KRAKEN_WORKTREE_CLEANUP` | `batch` | 3c | `eager` = cleanup per-worktree come oggi |
| `ZELARI_SPINE_REPLAY_CACHE` | `1` (dopo dogfood) | 4a | `0` = replay full-read sempre |
| `ZELARI_REQUEST_SNAPSHOT` | `full` | 4b | `full\|lite\|off` snapshot per round-trip TUI |
| `ZELARI_HEADLESS_FAILOVER` | `0` | 5b | `1` = failover cross-provider su headless/kraken |

### Esistenti rilevanti (nessun cambio di default in questo piano, salvo 3d/4a/4b con proprie commit di flip)

`ZELARI_KRAKEN_AUTO_MODEL` (1), `ZELARI_KRAKEN_CROSS_MODEL` (1), `ZELARI_KRAKEN_EXPLORE/VERIFY/GENERAL_MODEL` (1), `ZELARI_KRAKEN_SUB_MODEL`, `ZELARI_KRAKEN_PLANNER_MODEL` (1), `ZELARI_KRAKEN_WORKTREE` (3d), `ZELARI_KRAKEN_MAX_PARALLEL` (12), `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (6), `ZELARI_KRAKEN_MAX_REVIEW_ROUNDS` (1), `ZELARI_VERIFY_TYPECHECK/_TEST/_BUILD_CMD`, `ZELARI_VERIFY_TIMEOUT_MS` (600 000), `ZELARI_VERIFY_PACK`, `ZELARI_STRICT_DONE`, `ZELARI_LLM_COMPACT`, `ZELARI_COMPACT_MODEL` (4c), `ZELARI_PROVIDER_FIRST_TOKEN_IDLE_MS` (600 000), `ZELARI_PROVIDER_CONNECT_TIMEOUT_MS` (90 000), `ZELARI_PROVIDER_STREAM_IDLE_MS` (300 000), `ZELARI_PROVIDER_STREAM_MAX_MS` (1 800 000), `ZELARI_MEMORY_V2`, `ZELARI_MEMORY_AUTO_WRITE`.

---

## 14. Appendice B — file toccati per intervento

| Int. | File | Tipo |
|---|---|---|
| 1 | `src/cli/toolRegistry.ts` (~998), **nuovo** `src/cli/tools/krakenModelCandidates.ts` + test, `docs/GUIDA.md` | modifica + nuovo |
| 2a | `packages/core/src/verification/engine.ts`, helper `runWithLimit` (condiviso), test core | modifica |
| 2b | **nuovo** `src/cli/kraken/cachedShell.ts` + test; `packages/core/src/runtime/providers.ts` (`ShellResult.cached?`); `src/cli/kraken/nativeVerification.ts`; `src/cli/kraken/contractCompiler.ts` | nuovo + modifiche |
| 3a | `src/cli/tools/krakenRadio.ts` + test | modifica |
| 3b | `src/cli/kraken/executor.ts` (1740-1792) + test | modifica |
| 3c | `src/cli/kraken/krakenWorktree.ts`, `src/cli/kraken/executor.ts` + test | modifica |
| 3d | `docs/GUIDA.md`, poi default in `krakenWorktree.ts`/`taskTool.ts` (flip in commit dedicata) | doc → modifica |
| 4a | **nuovo** `packages/core/src/session/replayCache.ts` + test; `src/cli/sessionSpine.ts`; `src/cli/headlessSpine.ts` | nuovo + modifiche |
| 4b | `packages/core/src/core/requestSnapshot.ts` + test; `src/cli/hooks/useChatTurn.ts` (solo default) | modifica |
| 4c | `src/cli/memory/legacyImport.ts`, backend sqlite (`hasImports`), test | modifica |
| 5b | `src/cli/runHeadless.ts`, `src/cli/tools/taskTool.ts`, riuso `src/cli/providerFailover.ts` + test | modifica |

---

*Documento generato dall'analisi perf del 2026-09-10 (baseline `01a85bb`). Ogni stima di guadagno è ipotesi da validare con la Fase 0.*
