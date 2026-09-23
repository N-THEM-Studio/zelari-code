# Piano: prevenzione incongruenze memoria

Data: 2026-09-21 · Autore: Kraken lead · Stato: HYPOTHESIS (da implementare in BUILD)

## Contesto — le tre cause diagnosticate

1. **Contabilità divergente**: lavoro committato (`0ffaa0d`, t153–t156) ma `task_update` mai eseguita. Il pannello diceva il vero, il racconto in chat no.
2. **Fossili del vault riesumati**: keyword dell'era v0.10 ("compositor-only, inline-js≤5120b") presenti nelle fasi residue di `plan.json` e in `eval/results/edit-bench/baseline-wt2/` (baseline congelata) matchate dallo scope-generator.
3. **Layer mission-progress stale presentati come correnti**: `.zelari/state/commits/183ad3c951ae.json` (layer `mission:progress-6`, `ok=false`) mai superseded → il pannello lo ripresenta come "Durable State" corrente.

## Evidenza verificata oggi (non ipotesi)

- Il generatore del context-update **è nel tree**: `src/cli/workspace/composeContext.ts:79,269`, `src/cli/workspace/workspaceSummary.ts:167`, `src/cli/hooks/useChatTurn.ts:2581`, `src/cli/state/fileStateStore.ts:196`, più `packages/core/src/agents/{systemPromptBuilder,councilDirectives}.ts`. (Correzione: la lettura di ieri "nessun hit nel sorgente" usava un pattern troppo stretto.)
- I layer durable vivono su disco: `.zelari/state/commits/*.json` + `.zelari/state/artifacts/<commit>/`; loader in `src/cli/state/{fileStateStore,loadDurableContext,restoreState}.ts`.
- La spine resta intatta e append-only: nessuna delle tre cause la tocca. Sono tutte nei read-model.

## Principi

1. **Meccanico > disciplina**: la causa-1 è stata un errore umano (mio). La prevenzione non può essere "farò più attenzione": deve essere un check che fallisce il gate.
2. **La verità è append-only** (spine, git). I read-model (plan.json, state layers, pannelli) si riparano per confronto con la verità, non si prendono per buoni.
3. **Unknown ≠ pass vale per la contabilità**: un commit che referenzia un task pending è un fallimento di release, non un dettaglio.

## Slice A — `verify:plan-sync` (barriera meccanica, prioritaria)

**Cosa**: `scripts/verify-plan-sync.mjs` + npm script `verify:plan-sync` + chiamata nel gate di release (accanto a `verify:versions`).

**Design**:
- Sorgente verità: `git log` dai subject dei commit dall'ultimo tag annotato (`git describe --abbrev=0` → range).
- Estrazione id: `/\bt(\d+)\b/` **più espansione dei range** `t150-t152` (i nostri subject li usano).
- Confronto con `.zelari/plan.json`: commit che referenzia task non-`done` → **exit 1** con lista; task `done` dopo il tag senza commit di riferimento → warning (non fail: esistono chiusure docs-only).
- Nessuna nuova dipendenza: std lib node, pattern degli `scripts/verify-*.mjs` esistenti.

**Accettazione**: fixture che riproduce il caso t153–t156 (commit → task pending) dà exit 1; sullo stato attuale del repo exit 0; aggiunto al gate di release usato per il bump versione.

## Slice B — Igiene input del matcher

**Cosa** (tre mosse indipendenti):
1. `plan.json`: archiviare le fasi 1–7 dell'era v0.10 e la milestone "v0.10.0" in una sezione `archivedPhases` (verificare lo schema reale prima dell'edit; i task restano consultabili). Elimina alla radice le keyword fossili nello "Task scope".
2. `composeContext.ts`: escludere `eval/results/**` (e `plan-tasks/_archive*`) dalle sorgenti di keyword dello scope — una baseline congelata non è scope corrente.
3. Spazio di lavoro: ripulire il junction rotto `.zelari/sessions/.zelari/` (verificare prima che sia junction; poi rimozione) e **archiviare** (move, non delete) `.zelari/state/commits/183ad3c951ae.json` + `artifacts/183ad3c951ae/` in `.zelari/state/archive/`.

**Accettazione**: il context-update successivo non mostra più keyword v0.10 nello scope né la milestone v0.10.0; il walker spine gira senza errori.

## Slice C — Policy supersede/età per i layer durable (product code)

**Cosa**: quando `fileStateStore` scrive un layer di un kind già presente, marca i precedenti `supersededAt`; `loadDurableContext`/`composeContext` renderizzano l'età ("stale · 2026-09-18 · superseded by progress-7") invece di presentare l'ultimo-per-commit come corrente.

**File**: `src/cli/state/fileStateStore.ts`, `src/cli/state/loadDurableContext.ts`, `src/cli/workspace/composeContext.ts`.

**Accettazione**: unit test su fileStateStore (supersede allo stesso kind) + test render (layer vecchio etichettato stale); nessun default di scrittura cambiato; additive-only rispetto al formato esistente.

## Slice D — Backstop di processo (zero codice)

- Regola: **`task_update` nello stesso turno del commit** — resta scritta qui come backstop; il gate (Slice A) la rende comunque meccanica.
- Regola epistemica: **il pannello contraddice il racconto → si verifica prima di liquidarlo come stantio** (è l'aritmetica sbagliata che ho fatto ieri su "55/60").
- Entrambe candidate a AGENTS.MD via `/council` (auto-curato, no edit manuale).

## Ordine

A e B subito (barriera + togliere il rumore); C dopo; D immediato a costo zero.
**Primo atto BUILD in assoluto**: chiudere il debito t161 (vitest `src/cli/commands/` + `src/cli/tools/` e commit atomico) — non si apre lavoro nuovo con una slice non-verificata in tree.

## Out of scope

- t149 (rimozione engine A) — resta backlog come da finestra ADR-0039.
- Lead-usage su spine (chiamato informalmente "t162" in chat) — decisione separata, non confondere con gli id di questo piano.
- Qualsiasi modifica a runtime esterni al repo: non serve, il generatore è in-tree.
