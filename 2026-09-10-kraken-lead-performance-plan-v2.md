# Piano di intervento prestazionale v2 — Kraken, tentacoli e lead

> **Data v2:** 2026-09-10 (post-verifica su disco) · **Supera:** `2026-09-10-kraken-lead-performance-plan.md` (v1, root repo)
> **Stato:** proposta emendata. La diagnosi v1 è stata verificata riga per riga con 4 verifiche profonde (routing, gate/verification, executor/worktree, spine/TUI/provider). Esito: **~90% confermato, 2 difetti di design bloccanti corretti, 7 correzioni di dettaglio, 6 scoperte nuove** (→ backlog §15).
> **Ambito:** latenza end-to-end di `zelari-code` in modalità Kraken (grafo e lead+`task`), **senza ridurre i gate di qualità**.
> **Vincoli di repo:** commit atomici single-task, nessuna dipendenza pesante nuova, moduli nuovi ≤ 300 LOC, async-first, Zod per gli argomenti tool.
> **Gate per commit:** `npm run typecheck && npm run test && npm run verify:principles && npm run verify:versions` (script confermati in `package.json:32-33`).

---

## 0. Cambiamenti vs v1 (emendamenti)

| # | Cambiamento | Motivo (evidenza su disco) |
|---|---|---|
| E1 | **Int1 semplificato**: si riusa `resolveKrakenSubModelAsync` (`src/cli/tools/krakenModel.ts:307-327`) invece di creare `krakenModelCandidates.ts`. Da aggiungere solo il forward di `familyCandidates` nell'async (oggi carica `candidates` ma non li passa al ramo family) | Il modulo nuovo sarebbe duplicazione; lo sketch v1 della `ModelsRegistry` era sbagliato (shape piatta `{ grok?, glm?, … }`, staleness via `fetchedAt`, non mtime) |
| E2 | **Int2a declassato P0 → P1 opt-in, default `ZELARI_VERIFY_PARALLEL=0`** | La tesi "test non dipende da build" è **falsificata su questo repo**: `tsconfig.json:28,40` risolve `@zelari/core` → `packages/core/dist`; `pretest` = `npm run build --workspace=@zelari/core` (clean+tsc su dist); `build` pulisce gli stessi path. In parallelo → vitest può importare dist parziale/stale. Fail-closed (falsi FAIL flaky), ma il default ON romperebbe il gate |
| E3 | **Int2b scope esteso**: la cache memory-only è inerte col wiring attuale — ogni valutazione costruisce `NodeShellProvider`+`VerificationEngine` freschi (`nativeVerification.ts:191-208`, `contractCompiler.ts:213-218`) e `evaluateStrictBuildGate` (`verificationBridge.ts:462+`) non inietta shell. Serve plumbing per una shell condivisa per turno/mission. Stima M → **M+ (1.5-2 g)** | Le due chiamate gate di `runOneTurn.ts:749/796` e quella di fine mission non condividono oggi alcuna istanza |
| E4 | **Int3a precisato**: il radio ha **~14 call-site** (10 in `taskTool.ts`, + `planTaskTools.ts:364`, `taskStaleness.ts:80`, altri in kraken/), non solo "eventi tentacolo". Il fix resta interno al modulo (promise-chain); i caller non devono cambiare (append è già fire-and-forget) | Verifica call-site |
| E5 | **Int3c ridimensionato**: lifecycle worktree = **~12-16 subprocess git per writer** (non 8-10); la cleanup nel path grafo avviene per **merge-node**, non per writer → il guadagno del batch cleanup è minore del stimato. Priorità P1 → P2 | `krakenWorktree.ts:99-283` + path grafo |
| E6 | **Int4b descritto correttamente**: per round-trip sono **2 clone dei messaggi + 1 `structuredClone` per tool** (~30-50 tools) in `requestSnapshot.ts:113-154`; `contextGrowth.recordRequest` è **1 solo** `JSON.stringify` (`contextGrowth.ts:79-83`, claim v1 "idem" errato). La generazione gira in `AgentHarness` per **tutti gli host** (TUI, headless, tentacoli), non solo TUI → il flag ha portata più ampia (e il costo è più alto del stimato v1) | Verifica modulo |
| E7 | **Int4a call-sites completati**: oltre ai 7 siti v1 di `sessionSpine.ts`/`headlessSpine.ts`, ci sono `restoreRuntime.ts:26,41` e `harnessState.ts:339` → **10 call-site in `src/cli`** | Verifica call-site |
| E8 | Nomi/riferimenti corretti: test family = `krakenModel.family.test.ts` (non `krakenModel.test.ts`); `memory.remember` awaited a `taskTool.ts:1263-1297`; `linkMemoryGraph` ora a `executor.ts:1736-1796`; "Correction 4" sta nel docblock modulo `executor.ts:19`. **`strictDefaults.test.ts` NON copre `ZELARI_KRAKEN_WORKTREE`** → il flip 3d richiede un test nuovo, non un update | Verifica test suite |
| E9 | **Failover**: documentare i flag legacy `ANATHEMA_FAILOVER` / `ANATHEMA_FAILOVER_PROVIDER` accanto al nuovo `ZELARI_HEADLESS_FAILOVER` (coesistono; il nuovo è per headless/kraken) | `src/cli/providerFailover.ts` |
| E10 | **Bonus Int1**: il retry-404→parent (`taskTool.ts:1117-1153`) è **codice morto oggi** (`sub.fallback` popolato solo se model ≠ parent, che non avviene mai senza routing). Con Int1 si riattiva da solo → va coperto da test | Verifica dead-code |

---

## Indice

1. [Diagnosi (verificata)](#1-diagnosi-verificata)
2. [Principi guida e anti-goal](#2-principi-guida-e-anti-goal)
3. [Matrice interventi (v2)](#3-matrice-interventi-v2)
4. [Fase 0 — baseline e misurazione](#4-fase-0--baseline-e-misurazione)
5. [Intervento 1 (P0) — Model routing via `resolveKrakenSubModelAsync`](#5-intervento-1-p0--model-routing)
6. [Intervento 2 — Gate: cache condivisa (P0) + parallelo opt-in (P1)](#6-intervento-2--gate-cache-condivisa-p0--parallelo-opt-in-p1)
7. [Intervento 3 — Executor: radio, memory tail, worktree](#7-intervento-3--executor)
8. [Intervento 4 — Overhead per-turno](#8-intervento-4--overhead-per-turno)
9. [Intervento 5 (P2) — Provider: timeout e failover](#9-intervento-5-p2--provider)
10. [Quick win operativi (solo env)](#10-quick-win-operativi-solo-env)
11. [Piano di rilascio (v2)](#11-piano-di-rilascio-v2)
12. [Piano di test complessivo](#12-piano-di-test-complessivo)
13. [Appendice A — flag env](#13-appendice-a--flag-env)
14. [Appendice B — file toccati](#14-appendice-b--file-toccati)
15. [Backlog scoperto in verifica (fuori scope v2)](#15-backlog-scoperto-in-verifica-fuori-scope-v2)
16. [Registro della verifica](#16-registro-della-verifica)

---

## 1. Diagnosi (verificata)

Ogni claim v1 è stato ricontrollato sul codice attuale. Simboli: ✅ confermato · ⚠️ confermato con correzione · 🆕 nuovo.

### 1.1 Routing tentacoli ⚠️

- ✅ `resolveKrakenSubModel` prevede auto-pick cheap per `explore`/`verify` (`krakenModel.ts:222-229`) e cross-family per `verify` (`:209-220`); l'unico call-site di produzione (`toolRegistry.ts:998`) chiama **senza `opts`** → default `{}` → sempre modello del lead.
- ⚠️ Ma esiste già **`resolveKrakenSubModelAsync`** (`krakenModel.ts:307-327`) che carica la discovery cache e passa `candidates` — non cablata e non completa (manca il forward di `familyCandidates`).
- ⚠️ Shape registry reale: piatta (`{ grok?, glm?, … }`), TTL via `fetchedAt` (file `~/.zelari-code/models.json`).
- 🆕 Il retry-404→parent (`taskTool.ts:1117-1153`) è morto finché il routing non è cablato.

### 1.2 Gate strict-done ⚠️

- ✅ `VerificationEngine.evaluate` sequenziale `for...of`+`await` (`packages/core/src/verification/engine.ts:51-89`); `VerificationEngineOptions` ha solo `emit/now/sha256` (nessuna opzione concorrenza).
- ✅ Timeout 600 000 ms (`nativeVerification.ts:133-137`); `NodeShellProvider` spawna processi freschi, zero cache (`nodeProviders.ts:83-127`); `ShellResult` senza campo `cached` (`providers.ts:70-77`).
- ✅ Turno blocked → seconda valutazione post-repair (`runOneTurn.ts:796`); terza a fine mission (`runHeadless.ts`); tentacolo `verify` auto-generato per ogni `general`.
- 🆕 **Ma**: ogni valutazione costruisce engine+shell **freschi** (`nativeVerification.ts:191-208`, `contractCompiler.ts:213-218`) e `evaluateStrictBuildGate` (`verificationBridge.ts:462+`) non inietta shell → una cache memory-only decorata localmente non verrebbe mai riusata tra le valutazioni. → E3.
- 🆕 **Ma**: i comandi del pack di questo repo **interferiscono** (tsconfig → `packages/core/dist`; `pretest` rebuilda core con clean; `build` pulisce gli stessi path) → il parallelismo default-ON è insicuro qui. → E2.

### 1.3 Serializzazioni executor ⚠️

| Punto | Riferimento (verificato) | Verdetto |
|---|---|---|
| Merge finale sequenziale (Correction 4, docblock `executor.ts:19`) | `executor.ts` merge loop | ✅ non si tocca |
| Scope non dichiarato = `**` | `fileOwnership.ts:95-101`; `arbitrateAdmission` `:195-214` | ✅ |
| Worktree lifecycle | `krakenWorktree.ts:99-283` | ⚠️ **12-16** subprocess/writer; cleanup per **merge-node** nel grafo |
| Radio `appendFileSync` | `krakenRadio.ts:138` | ⚠️ **~14 call-site** (10 in `taskTool.ts`, `planTaskTools.ts:364`, `taskStaleness.ts:80`, …) |
| `linkMemoryGraph` sequenziale | `executor.ts:1736-1796` | ✅ (drift +4 righe vs v1) |
| `memory.remember` awaited | `taskTool.ts:1263-1297` | ✅ (drift) |

### 1.4 Overhead per-turno ⚠️

- ✅ `readSessionLog` full-read + Zod per riga (`packages/core/src/session/replay.ts:40-92`); **10 call-site** in `src/cli`: `sessionSpine.ts` (279, 490-508, 515-522, 701-725), `headlessSpine.ts` (121-136, 323), `restoreRuntime.ts` (26, 41), `harnessState.ts` (339). Nessun modulo incrementale esistente (grep `replayCache|replayCursor` = 0).
- ⚠️ requestSnapshot: **2 clone messaggi + 1 structuredClone per tool** per round-trip (`requestSnapshot.ts:113-154`); `contextGrowth.recordRequest` = 1 `JSON.stringify` (`contextGrowth.ts:79-83`). Generazione in `AgentHarness` → **tutti gli host**, non solo TUI.
- ✅ Compaction LLM default ON, bloccante a ≥85% (`llmCompact.ts:54-59`; soglia `tokenBudget.ts:197`); doppia full-read attorno alla compaction (`modelContextBuilder.ts:127, 189`).
- ✅ Memory: worker SQLite + import legacy ricostruiti per turno (`useChatTurn.ts:332`); `hasImport` RPC **per riga** (`legacyImport.ts:50-63`, `sqliteBackend.ts:641-647`); nessun marker di import completato, nessun batch.

### 1.5 Provider ✅

- First-token idle 600 s default con nota reasoning (`openai-compatible.ts:57-58, 86-90`).
- Failover cross-provider **solo TUI** (`useChatTurn.ts:449-476`); 0 riferimenti in `runHeadless`/`taskTool`. Flag legacy: `ANATHEMA_FAILOVER`, `ANATHEMA_FAILOVER_PROVIDER`.
- Planner: completion non-streaming (`planner.ts:65`, ~`:663`), modello del lead salvo `ZELARI_KRAKEN_PLANNER_MODEL`.

---

## 2. Principi guida e anti-goal

**Principio centrale (invariato): la lentezza sta nell'esecuzione, non nei gate.**

**Nuovo principio (da E2): nessun parallelismo default-ON su comandi che possono interferire.** Il default di `ZELARI_VERIFY_PARALLEL` è `0` finché i comandi del pack non sono dimostrati indipendenti per-repo. Un gate flaky-FAIL è inaccettabile quanto un falso PASS: ammazzerebbe la fiducia nel strict-done.

### Anti-goal (invariati + E)

1. ❌ `ZELARI_STRICT_DONE`, `ZELARI_MISSION_STRICT` ON. Nessun indebolimento di `CompletionPolicy`, `unknown ≠ pass`, evidence anchoring, proof persistence.
2. ❌ Verify pack ON. Cache e (opt-in) parallelismo non cambiano *verdicts*: stesso comando, stesso exit code, evidenza marcata `cached` quando riusata.
3. ❌ Budget repair/rework (1) invariati; i tentacoli `verify` restano, cambia solo il modello (routing).
4. ❌ Merge sequenziali (Correction 4) intatti.
5. ❌ Nessuna dipendenza nuova.
6. ❌ `general` resta sul modello forte.
7. 🆕 ❌ Nessun nuovo default ON che alteri l'esito del gate su repo con comandi interferenti (vedi principio nuovo).

### Invarianze da dimostrare nei test

- Stessi verdict per criterio (stesso input → stesso `status`, stesso `CompletionPolicy`, stessi exit code 0/2/3/4).
- Evidence anchoring: `EvidenceRef.seq` valido, digest invariati o marcata `cached: true`.
- Ogni nuovo comportamento ha kill-switch env che ripristina il comportamento precedente.
- 🆕 Per 2a: suite che dimostri l'**assenza di interferenza** sui comandi del target repo prima di qualsiasi flip di default.

---

## 3. Matrice interventi (v2)

| # | Intervento | Priorità v2 | Sforzo | Rischio | Guadagno atteso* | Kill-switch |
|---|---|---|---|---|---|---|
| 1 | Routing via `resolveKrakenSubModelAsync` (+familyCandidates) | **P0** | **XS-S (¼-½ g)** ↓ | Basso | −30/−60% wall-clock grafo | `ZELARI_KRAKEN_AUTO_MODEL=0`, `ZELARI_KRAKEN_CROSS_MODEL=0` |
| 2b | Cache comandi + **plumbing shell condivisa per turno/mission** | **P0** | **M+ (1.5-2 g)** ↑ | Basso-medio | elimina 2ª/3ª esecuzione gate | `ZELARI_VERIFY_CACHE=0` |
| 2a | Criteri pack in parallelo | **P1 opt-in** ↓ (era P0) | S | Medio | gate ≈ max(durate) **solo se comandi indipendenti** | `ZELARI_VERIFY_PARALLEL` (default **0** ↑) |
| 3a | Radio async (promise-chain) | P1 | XS | Basso | event loop libero con N tentacoli | `ZELARI_KRAKEN_RADIO=sync` |
| 3b | `linkMemoryGraph` parallelizzato (limite 8) | P1 | XS | Basso | tail latency post-run | fail-open esistente |
| 3c | Worktree: memo root + cleanup batch | **P2** ↓ (era P1) | S | Basso | −2-4 subprocess/writer (guadagno batch minore del previsto) | `ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` |
| 3d | Default `WORKTREE=auto` | P1 (decisione) | XS codice, M validate | Medio | writer sovrapposti in parallelo | `ZELARI_KRAKEN_WORKTREE=off` |
| 4a | Replay incrementale spine | P1 | M (1-2 g) | Medio | 10 letture full → 1 per sessione | `ZELARI_SPINE_REPLAY_CACHE=0` |
| 4b | requestSnapshot `lite` | P2 | M | Medio | −(2+T) clone/round-trip su **tutti gli host** | `ZELARI_REQUEST_SNAPSHOT=full` |
| 4c | Memory import: marker + batch `hasImports` | P1 | S | Basso | elimina N query RPC/turno | rimozione marker |
| 5a | Doc/tuning first-token idle | P2 | XS | — | evita stalli 10 min | env per-call |
| 5b | Failover headless/kraken | P2 | M | Medio | resilienza | `ZELARI_HEADLESS_FAILOVER=0` |

\* Stime da validare in Fase 0; nessun numero è una promessa.

---

## 4. Fase 0 — baseline e misurazione

Invariata rispetto a v1, con due aggiunte:

1. **Configurazioni misurate:** (a) baseline; (b) env quick-win §10; (c) dopo ogni intervento; **(d) `ZELARI_VERIFY_PARALLEL=1` su repo con comandi indipendenti** — per quantificare il guadagno di 2a senza esporlo come default.
2. **Metrica aggiuntiva:** frequenza first-token > 120 s per provider (alimenta la decisione 5a) e **flakiness del gate** (verdict oscillanti tra run) — hard blocker per qualsiasi flip di default di 2a.

Strumenti (confermati): `durationMs` per nodo (`graphStatus.ts`, `KrakenExecutionSummary`), radio JSONL, workbench md, `VerificationResult.durationMs` nei proof. Script opzionale `scripts/perf-bench.mjs` (≤ 150 LOC).

Criteri di uscita: tabella baseline (mediana + deviazione); confronto (a) vs (b) per ordinare gli interventi.

---

## 5. Intervento 1 (P0) — Model routing

### 5.1 Obiettivo (invariato)

`explore`/`verify` su modello economico/auto-pick, `verify` cross-family quando disponibile, `general` invariato sul modello del lead.

### 5.2 Modifica (v2 — semplificata, E1)

**Nessun modulo nuovo.** Due modifiche:

**A. Completare `resolveKrakenSubModelAsync`** (`src/cli/tools/krakenModel.ts:307-327`): oggi carica la discovery e passa `candidates`, ma **non costruisce/passa `familyCandidates`**. Aggiungere la costruzione cross-family dalla registry reale (shape piatta, TTL via `fetchedAt`):

```ts
// dentro resolveKrakenSubModelAsync, dopo il load della registry
const familyCandidates = Object.entries(registry ?? {}).flatMap(([provider, entry]) =>
  (entry?.models ?? []).map((m) => ({ provider, model: m.id })));
// … e forwardarli in opts insieme ai candidates esistenti
```

(Adattare i nomi di campo alla shape effettiva di `modelDiscovery.ts`; fail-open su registry mancante → `{ candidates: [], familyCandidates: [] }`.)

**B. Cablare il call-site** (`src/cli/toolRegistry.ts:998`, dentro `createSubAgentContextFactory`, già async):

```ts
const { resolveKrakenSubModelAsync } = await import('./tools/krakenModel.js');
const parentModel = modelOverride || cfg.model;
const resolvedModel = await resolveKrakenSubModelAsync(agent, parentModel, process.env, {
  provider: cfg.providerId,
});
```

Note:

- **Cross-family**: il ref qualificato `provider/model` è già gestito dal call-site (`providerConfigFor`); provider senza credenziali → id raw → 404 → **retry-una-volta sul parent** (`taskTool.ts:1117-1153`) che con questo fix smette di essere codice morto (E10) e va coperto da test.
- **Fail-open invariato**: niente discovery → candidates vuoti → parent model (comportamento odierno).

### 5.3 Documentazione (invariata)

`docs/GUIDA.md` sezione routing Kraken: promuovere a "consigliata" la config `ZELARI_KRAKEN_PLANNER_MODEL` / `ZELARI_KRAKEN_EXPLORE_MODEL` / `ZELARI_KRAKEN_VERIFY_MODEL`. Nota v2: con l'auto-pick cablato, `EXPLORE_MODEL` esplicito diventa override, non unico mezzo.

### 5.4 Test

- `krakenModel.family.test.ts` (nome corretto, E8): estendere con il forward `familyCandidates` dall'async.
- Integrazione factory `toolRegistry`: candidates cheap → `explore` risolve cheap, `general` parent, `verify` cross-family; `ZELARI_KRAKEN_AUTO_MODEL=0` → sempre parent (bit-identico a oggi).
- 🆕 Retry-404→parent: test del percorso fallback (modello routed non autorizzato → retry su parent) ora raggiungibile.

### 5.5 Accettazione

- [ ] Benchmark Fase 0: `explore`/`verify` su modello ≠ lead con discovery popolata (workbench md, colonna modello).
- [ ] `general` invariato.
- [ ] `ZELARI_KRAKEN_AUTO_MODEL=0` → routing identico a pre-fix.
- [ ] Test del retry-404→parent verde (percorso prima morto).

### 5.6 Rischi

| Rischio | Mitigazione |
|---|---|
| Cheap model peggiora verify | Rework budget + gate deterministico a valle; kill-switch; cross-family preferito |
| Discovery assente/scaduta | Fail-open su parent |
| `general` degradato per errore | Anti-goal esplicito: auto-pick solo `explore`/`verify` (test matrice) |

---

## 6. Intervento 2 — Gate: cache condivisa (P0) + parallelo opt-in (P1)

### 6.1 Obiettivo

Stessi verdict, stessa evidenza: (2b) riuso dei risultati quando l'albero non cambia tra valutazioni dello stesso processo — **con plumbing perché le valutazioni condividano davvero la shell**; (2a) comandi in parallelo, **solo opt-in**, dopo dimostrata indipendenza.

### 6.2 Cache (2b) — v2 con plumbing (E3)

**Passo 1 — Plumbing shell condivisa.** Oggi ogni sito costruisce engine+shell freschi. Modifiche:

- `src/cli/kraken/nativeVerification.ts:191-208` e `src/cli/kraken/contractCompiler.ts:213-218`: accettare una `shell` iniettata (default: costruzione attuale, retrocompatibile).
- `src/cli/headless/verificationBridge.ts` (`evaluateStrictBuildGate`, ~`:462+`): creare **una sola** `NodeShellProvider` decorata `CachedShellProvider` per turno (o per mission) e passarla a pack + contract compiler, così la 2ª valutazione post-repair e la 3ª a fine mission condividono la cache.

**Passo 2 — Decoratore `CachedShellProvider`** (nuovo `src/cli/kraken/cachedShell.ts`, ≤ 200 LOC). Chiave:

```ts
const key = sha256(JSON.stringify({
  command,
  cwd: opts?.cwd ?? '',
  timeoutMs: opts?.timeoutMs ?? null,
  tree: await treeState(cwd), // 'HEAD:<sha>|<sha256(git status --porcelain)>', TTL 5 s
}));
```

- `treeState`: `git rev-parse HEAD` + `git status --porcelain` (memo TTL 5 s); copre tracked+untracked → qualsiasi scrittura invalida.
- Memory-only, LRU 32. Nessuna persistenza in v1.
- **Evidenza onesta**: `ShellResult.cached?: boolean` (nuovo campo opzionale in `packages/core/src/runtime/providers.ts`); propagazione in `verification.evidence` (`cached: true`), suffisso nel `detail`, `durationMs` reale della hit. Digest stdout identico → anchoring F3 valido.
- Kill-switch `ZELARI_VERIFY_CACHE=0` (default ON).

**Cosa NON cambia**: ordine slot `verification.run`; contratti `Verify:` non-gated sul pack ma ora su engine con cache condivisa; repair pass ed exit-4 intatti.

### 6.3 Parallelo (2a) — v2 declassato (E2)

Design tecnico invariato (runWithLimit counter-based, ordine risultati preservato, `commandConcurrency` in `VerificationEngineOptions`, eventi evidence interleaved ammissibili perché l'ancoraggio è per-seq), **ma**:

- **Default `ZELARI_VERIFY_PARALLEL=0`.**
- **Prerequisito per l'opt-in su un repo**: comandi del pack mutuamente indipendenti. Su zelari-code oggi NON lo sono (`tsconfig.json:28,40` → `packages/core/dist`; `pretest` = rebuild core con clean; `build` pulisce gli stessi path). Opzioni per sbloccare (decisione a parte, 2.39):
  1. documentare `ZELARI_VERIFY_TYPECHECK_CMD="tsc --noEmit -p tsconfig.json"` (già suggerito in §10) + rimuovere il rebuild dal path test, oppure
  2. ridisegnare i comandi del pack per l'indipendenza (es. typecheck su source con project references, test contro dist pre-buildato dal build stesso).
- Il fallimento eventuale da interferenza è fail-closed (falsi FAIL), mai falsi PASS — ma flaky-FAIL sul gate di default è inaccettabile (principio §2).

### 6.4 Test

- **Cache** (`cachedShell.test.ts`): stesso comando+tree → shell invoked once, `cached: true`; tree change → re-invoked; LRU; `ZELARI_VERIFY_CACHE=0` bypass; TTL treeState.
- **Plumbing (v2)**: due `evaluateStrictBuildGate` nello stesso turno → **una sola** istanza shell (spy); senza plumbing (default vecchio) → comportamento attuale.
- **Invarianza verdicts**: property test fake shell deterministico — sequenziale vs cached → stessi `status`, stessi digest, stesso `CompletionPolicy`.
- **Integrazione**: blocked → repair senza delta → 2ª valutazione < 2 s, exec count invariato, exit 4 invariato.
- **Parallelo (opt-in)**: wall-clock < 250 ms con 3 criteri ×100 ms; `ZELARI_VERIFY_PARALLEL=0` → ≥ 300 ms; concorrenza limitata rispettata; **suite anti-interferenza** sui comandi di questo repo prima di qualunque flip.

### 6.5 Accettazione

- [ ] Blocked+repair senza delta: 2ª valutazione < 2 s; proof con `cached: true`.
- [ ] (Solo se opt-in 2a) gate ≈ max(durate) **e zero flakiness su N=3 run ripetuti**.

---

## 7. Intervento 3 — Executor

### 7.1 Radio asincrona (3a) — P1, XS

`krakenRadio.ts:138`: `appendFileSync` → promise-chain (pattern spine writer). **Nota v2 (E4)**: ~14 call-site, ma il fix è interno — l'API di emit resta fire-and-forget, i caller non cambiano.

```ts
let radioChain: Promise<void> = Promise.resolve();
function appendLine(file: string, line: string): Promise<void> {
  radioChain = radioChain.then(() => fs.appendFile(file, line)).catch(() => {});
  return radioChain;
}
```

Test: 100 emit concorrenti → righe in ordine e complete; kill-switch opzionale `ZELARI_KRAKEN_RADIO=sync`.

### 7.2 Memory tail (3b) — P1, XS

`executor.ts:1736-1796`: `memory.connect` per edge parallelizzato (limite 8, `runWithLimit` condiviso), `consolidate` awaited, entrambi fail-open. Test: K edge × 50 ms → ≈ ceil(K/8)×50 ms; fallimenti isolati non propagano.

### 7.3 Worktree micro-opt (3c) — **P2** (downgrade E5)

Memo `git rev-parse --show-toplevel` per processo; cleanup branch/prune batchizzato a fine run (`ZELARI_KRAKEN_WORKTREE_CLEANUP=eager` per tornare indietro). **Aspettativa ridotta**: lifecycle = 12-16 subprocess/writer e la cleanup nel grafo è per merge-node → il batch taglia meno del previsto; tenere solo se la Fase 0 lo conferma.

### 7.4 Default `WORKTREE=auto` (3d) — decisione, invariata

Rollout: 2.38 doc "consigliato su repo medio-grandi" + misura; dogfood ≥ 1 settimana (metriche: conflict-rate merge, wall-clock writer vs graph); 2.39 eventuale flip con **test nuovo** (E8: `strictDefaults.test.ts` non copre questo flag — scriverlo alla commit di flip, revertabile).

### 7.5 Test

Come v1 §7.5, con la correzione E8 sul test del flip 3d.

---

## 8. Intervento 4 — Overhead per-turno

### 8.1 Replay incrementale spine (4a) — P1, il pezzo grosso

Design invariato (nuovo `packages/core/src/session/replayCache.ts` ≤ 250 LOC; lettura posizionale dei soli byte nuovi; `partial` per righe troncate; full re-read su troncamento/rotazione; kill-switch `ZELARI_SPINE_REPLAY_CACHE=0`, merge dietro flag, flip dopo dogfood).

**Cablaggio v2 (E7) — 10 call-site in `src/cli`:**

- `src/cli/sessionSpine.ts`: 279 (adopt), 490-508 (derive + compaction snapshot/re-derive), 515-522 (lastVerificationRun), 701-725 (steer task-contract)
- `src/cli/headlessSpine.ts`: 121-136 (countVerificationEvidence), 323 (seed)
- `src/cli/restoreRuntime.ts`: 26, 41
- `src/cli/harnessState.ts`: 339

`readSessionLog` pubblica resta intatta. Nota onestà invariata: `deriveMessages` resta O(eventi); si elimina il costo IO/parse dominante.

### 8.2 requestSnapshot `lite` (4b) — P2, descrizione corretta (E6)

Costo reale per round-trip: **2 shallow-deep clone dei messaggi + 1 `structuredClone` per tool** (~30-50) in `requestSnapshot.ts:113-154`, **tutti gli host** (la generazione è in `AgentHarness`). `contextGrowth` = 1 stringify.

Design: `ZELARI_REQUEST_SNAPSHOT=full|lite|off` (default `full` in 2.38):

- `lite`: shallow-copy di primo livello; fingerprint header memoizzato per harness run (identity su tools array + hash system); digest `stableStringify` **lazy** via getter.
- `off`: solo metering base (audit ridotto — documentato).

Test: parità digest full vs lite (property); lazy calcolato al primo accesso; store funzionante in lite.

### 8.3 Compaction (config) — invariata

Documentare `ZELARI_COMPACT_MODEL` su modello cheap; il beneficio della doppia full-read arriva gratis da 8.1.

### 8.4 Memory import legacy (4c) — P1, invariata

Marker di import completato (meta table o file sidecar) → boot successivi non leggono `log.jsonl`; batch `hasImports(ids)` (IN chunked 500) al backend SQLite sostituisce la RPC per riga. Test: secondo boot → zero query; conteggi identici; marker mancante → comportamento attuale. Fuori scope: worker SQLite persistente tra turni.

---

## 9. Intervento 5 (P2) — Provider

### 9.1 First-token idle (5a) — invariato

Solo documentazione in v1 (profili consigliati 120-180 s non-reasoning; Grok/GLM-thinking 600 s). Decisione dati-driven con metrica Fase 0 (frequenza first-token > 120 s per provider).

### 9.2 Failover headless/kraken (5b) — con nota flag legacy (E9)

Design invariato (`ZELARI_HEADLESS_FAILOVER=1` opt-in; risoluzione target una volta per run; swap single-shot su errore transiente; evento audit `provider.failover`). **v2**: nella stessa sezione di GUIDA documentare i flag legacy `ANATHEMA_FAILOVER` / `ANATHEMA_FAILOVER_PROVIDER` (precedenza/separazione di intenti esplicitati).

---

## 10. Quick win operativi (solo env)

```bash
# Routing tentacoli (il fix più importante SENZA codice)
export ZELARI_KRAKEN_PLANNER_MODEL="glm/glm-4.7-air"
export ZELARI_KRAKEN_EXPLORE_MODEL="glm/glm-4.7-air"
export ZELARI_KRAKEN_VERIFY_MODEL="grok/grok-3-mini"   # se hai 2 provider

# Writer sovrapposti in parallelo
export ZELARI_KRAKEN_WORKTREE=auto

# Compaction su modello cheap
export ZELARI_COMPACT_MODEL="glm/glm-4.7-air"

# Gate: budget più stretti dove il repo è veloce
export ZELARI_VERIFY_TIMEOUT_MS=300000
export ZELARI_VERIFY_TYPECHECK_CMD="tsc --noEmit -p tsconfig.json"  # evita rebuild core

# NOTA v2: NON abilitare parallelismo gate via env — ZELARI_VERIFY_PARALLEL non esiste
# ancora e, quando esisterà (2a), partirà default OFF su questo repo (E2).
```

NOTA: senza l'Intervento 1, `EXPLORE/VERIFY_MODEL` espliciti restano l'unico mezzo per tentacoli economici.

---

## 11. Piano di rilascio (v2)

Convenzioni: commit atomiche single-task, tutte verdi ai gate, CHANGELOG. Ogni deliverable autonomamente revertabile.

| Ordine | Deliverable | Target |
|---|---|---|
| 0 | Baseline benchmark + script raccolta | subito |
| 1 | **Int1 routing** (async + familyCandidates + call-site + test + GUIDA) | 2.38.0 |
| 2 | **Int2b cache + plumbing shell condivisa** | 2.38.0 |
| 3 | Int3a radio async + Int3b memory tail (commit separate) | 2.38.x |
| 4 | Int4a replay cache (flag ON in eval, flip dopo dogfood) | 2.38.x |
| 5 | Int4c memory import marker+batch | 2.38.x |
| 6 | **Int2a engine parallelo dietro flag default OFF** + doc prerequisiti per-repo | 2.38.x |
| 7 | Int3c worktree micro-opt (P2 — solo se Fase 0 conferma) | 2.39 |
| 8 | Int4b snapshot lite (default `full`, dogfood `lite`) | 2.39 |
| 9 | Int3d decisione default `WORKTREE=auto` (con dati + test nuovo) | 2.39 |
| 10 | Int5b failover headless opt-in | 2.39 |

Dipendenze: nessuna per correttezza; `runWithLimit` estratto nella prima commit che lo usa (3b o 2a, chi arriva prima) e riusato dall'altra.

---

## 12. Piano di test complessivo

### Per-commit (minimo)

```
npm run typecheck
npm run test
npm run verify:principles
npm run verify:versions
```

### Suite di non-regressione qualità (ogni deliverabile P0/P1)

1. **Gate invariance**: stessi verdict/criterio, stesso `CompletionPolicy`, stessi exit code (0/2/3/4) — property test con fake shell deterministico.
2. **Evidence anchoring**: `EvidenceRef.seq` valido + `cached: true` sulle riusate; digest invariati.
3. **Routing matrix**: explore/verify/general × (candidates presenti/assenti/auto-model off) → modello atteso; + percorso retry-404→parent.
4. **Spine**: replay incrementale vs full su log con gap/duplicate/corrupt/torn-line → `ReplayReport` equivalenti.
5. **Anti-interferenza (2a)**: N=3 run ripetuti del gate su questo repo senza oscillazioni di verdict — prerequisito per qualunque flip di default.
6. **Eval esistenti** (`eval/`): nessuna regressione qualità.

### Benchmark di latenza (per deliverable, protocollo §4)

Mediana N=3 vs baseline: wall-clock totale, wall-clock gate, durate per kind nodo, round-trip provider. Deliverable che non migliora la propria metrica: tenuto solo se ha altro valore (resilienza/audit) e documentato.

---

## 13. Appendice A — flag env

### Nuovi (v2)

| Flag | Default v2 | Int. | Significato |
|---|---|---|---|
| `ZELARI_VERIFY_PARALLEL` | **`0`** ↑ (era `1`) | 2a | `1` = criteri in parallelo (solo repo con comandi indipendenti) |
| `ZELARI_VERIFY_CONCURRENCY` | `3` | 2a | max comandi concurrently |
| `ZELARI_VERIFY_CACHE` | `1` | 2b | `0` = nessun riuso risultati |
| `ZELARI_KRAKEN_WORKTREE_CLEANUP` | `batch` | 3c | `eager` = cleanup per singolo worktree/merge-node come oggi |
| `ZELARI_SPINE_REPLAY_CACHE` | `1` (dopo dogfood) | 4a | `0` = replay full-read |
| `ZELARI_REQUEST_SNAPSHOT` | `full` | 4b | `full\|lite\|off` |
| `ZELARI_HEADLESS_FAILOVER` | `0` | 5b | `1` = failover cross-provider headless/kraken |

### Esistenti rilevanti (confermati)

`ZELARI_KRAKEN_AUTO_MODEL`, `ZELARI_KRAKEN_CROSS_MODEL`, `ZELARI_KRAKEN_EXPLORE/VERIFY/GENERAL_MODEL`, `ZELARI_KRAKEN_SUB_MODEL`, `ZELARI_KRAKEN_PLANNER_MODEL`, `ZELARI_KRAKEN_WORKTREE` (default `off`), `ZELARI_KRAKEN_MAX_PARALLEL` (12), `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (6), `ZELARI_KRAKEN_MAX_REVIEW_ROUNDS` (1), `ZELARI_VERIFY_TYPECHECK/_TEST/_BUILD_CMD`, `ZELARI_VERIFY_TIMEOUT_MS` (600 000), `ZELARI_VERIFY_PACK`, `ZELARI_STRICT_DONE`, `ZELARI_LLM_COMPACT`, `ZELARI_COMPACT_MODEL`, `ZELARI_PROVIDER_FIRST_TOKEN_IDLE_MS` (600 000), `ZELARI_PROVIDER_CONNECT_TIMEOUT_MS` (90 000), `ZELARI_PROVIDER_STREAM_IDLE_MS` (300 000), `ZELARI_PROVIDER_STREAM_MAX_MS` (1 800 000), `ZELARI_MEMORY_V2`, `ZELARI_MEMORY_AUTO_WRITE`.
**Legacy failover (E9):** `ANATHEMA_FAILOVER`, `ANATHEMA_FAILOVER_PROVIDER`.

---

## 14. Appendice B — file toccati (v2)

| Int. | File | Tipo |
|---|---|---|
| 1 | `src/cli/tools/krakenModel.ts` (async + familyCandidates), `src/cli/toolRegistry.ts` (~998), test `krakenModel.family.test.ts` + factory, `docs/GUIDA.md` | modifica |
| 2b | **nuovo** `src/cli/kraken/cachedShell.ts` + test; `packages/core/src/runtime/providers.ts` (`ShellResult.cached?`); `src/cli/kraken/nativeVerification.ts`; `src/cli/kraken/contractCompiler.ts`; `src/cli/headless/verificationBridge.ts` (plumbing shell condivisa) | nuovo + modifiche |
| 2a | `packages/core/src/verification/engine.ts` (+`runWithLimit` condiviso), test core | modifica |
| 3a | `src/cli/tools/krakenRadio.ts` + test | modifica |
| 3b | `src/cli/kraken/executor.ts` (1736-1796) + test | modifica |
| 3c | `src/cli/kraken/krakenWorktree.ts`, `src/cli/kraken/executor.ts` + test | modifica |
| 3d | `docs/GUIDA.md`, flip default in `worktreeScheduling.ts` + **test nuovo** (strictDefaults non copre) | doc → modifica |
| 4a | **nuovo** `packages/core/src/session/replayCache.ts` + test; `src/cli/sessionSpine.ts`; `src/cli/headlessSpine.ts`; `src/cli/restoreRuntime.ts`; `src/cli/harnessState.ts` | nuovo + modifiche |
| 4b | `packages/core/src/core/requestSnapshot.ts` + test; default in harness | modifica |
| 4c | `src/cli/memory/legacyImport.ts`, backend sqlite (`hasImports`), test | modifica |
| 5b | `src/cli/runHeadless.ts`, `src/cli/tools/taskTool.ts`, riuso `src/cli/providerFailover.ts`/`crossProviderFailover.ts` + test | modifica |

---

## 15. Backlog scoperto in verifica (fuori scope v2)

1. **Race `reputationStore.ts:46`**: append parallele non serializzate su `reputation.jsonl` — stesso pattern promise-chain di 3a; fix da valutare a parte (correttezza, non solo perf).
2. **Tool registry ricostruito per turno** (`useChatTurn.ts:411/633/834`): rebuild completo del registry a ogni turno TUI — candidate a memoizzazione per sessione.
3. **`tokenBudget.ts:485-534`**: 3 sweep `JSON.stringify` dell'intera history per turno — unificare in un solo pass.
4. **`WORKTREE=auto` nel path CLI** (`taskTool.ts:905-920`): la decisione worktree è locale al tentacolo — anche writer non-overlapping pagano il costo worktree; armonizzare col scheduling centrale prima del flip 3d.
5. **Env per-persona non coperti dal routing Kraken**: `SPEC/CONFORMANCE/ORACLE_MODEL`, `ZELARI_KRAKEN_GENERAL_USES_SUB`, distinzione advisory-verifier (`ZELARI_KRAKEN_SELECT_*`) — mappare e documentare nella stessa sezione GUIDA dell'Int1.
6. **Wiring env lato Desktop**: non verificato in questa tornata — da controllare prima di promuovere i quick-win come default Desktop.

---

## 16. Registro della verifica

Diagnosi v1 verificata su disco (2026-09-10) con 4 verifiche profonde parallelle:

- **t1 routing** — `krakenModel.ts`, `toolRegistry.ts`, `modelDiscovery.ts`, `taskTool.ts`: call-site senza opts confermato; `resolveKrakenSubModelAsync` esistente e incompleta; retry-404 morto; shape registry reale.
- **t2 gate/verification** — `engine.ts`, `nativeVerification.ts`, `contractCompiler.ts`, `verificationBridge.ts`, `nodeProviders.ts`, `providers.ts`, `tsconfig.json`, script npm: sequenzialità confermata; istanze fresche per valutazione; interferenza comandi pack su questo repo.
- **t3 executor/worktree** — `executor.ts`, `fileOwnership.ts`, `worktreeScheduling.ts`, `krakenWorktree.ts`, `krakenRadio.ts`: wildcard/admission/rescue confermati; 12-16 subprocess/writer; ~14 call-site radio.
- **t4 spine/TUI/provider** — `replay.ts`, `sessionSpine.ts`, `headlessSpine.ts`, `restoreRuntime.ts`, `harnessState.ts`, `requestSnapshot.ts`, `contextGrowth.ts`, `llmCompact.ts`, `modelContextBuilder.ts`, `useChatTurn.ts`, `legacyImport.ts`, `sqliteBackend.ts`, `openai-compatible.ts`, `planner.ts`, failover: 10 call-site replay; costo snapshot reale (2+T clone, tutti gli host); failover solo TUI; flag legacy.

Ogni stima di guadagno resta ipotesi da validare con la Fase 0.

---

*v2 generato il 2026-09-10. Sostituisce la v1; alla commit di BUILD marcare la v1 come superseded o eliminarla. Destinazione consigliata nel repo: `.zelari/docs/` (design vault) + eventuale copia a root per visibilità.*
