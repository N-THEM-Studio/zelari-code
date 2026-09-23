# Piano tentacoli P1–P3 — prompt, contratto verify, telemetria, guard

Data: 2026-09-21 · Fase: PLAN → BUILD
Fonte ricerca: `.zelari/docs/2026-09-21-ricerca-tentacoli-ottimizzazione.md`
File principe: `src/cli/tools/taskTool.ts` (2251 righe, snapshot `da207e6f0270b63e`)

## Correzioni alla ricerca (verificate sul tree oggi)

1. **P1b riformulato.** Non è "il parser consuma solo l'XML". I due contratti sono ciascuno autoconsistente col proprio parser (`parseVerifyReport` per il verify esplicito, `parseVerifyVerdict` per l'auto-verify). Il difetto vero è di **sovrapposizione**: l'auto-verify spawna `agent: 'verify'` → il tentacolo riceve il system prompt `VERIFY_PROMPT` ("termina con UN blocco `<verify-report>` per criterio") E il task prompt `buildTaskAutoVerifyPrompt` ("`VERDICT: PASS` come ULTIMA riga"). Due istruzioni di formato finali in conflitto sullo stesso modello. Se obbedisce al system prompt, il trailer manca → verdict `unknown` → debito non scioglie/riwork non parte.
2. **P3 ridimensionato.** `permissionsForTaskAgent` dà `['read','execute','network']` al verify (~152–162): la rete serve a bash (`npm install` in worktree fresco). Cecità ≠ offline. Non si toglie la rete: si documenta il perché e si advertise la policy nel prompt.
3. **Consumatori VERDICT confermati** (grep odierno): il trailer è load-bearing — `kraken/executor.ts:2271` (rework loop), `kraken/planner.ts:845–849` (stesso stacking nel path grafo), `narrativeFloor`/`verificationBridge` (trailer advisory). **P1b non può rimuovere il trailer**: deve comporre i due formati.
4. Pattern spine consolidato già in house: `verifyDebtSpine.ts` + `enqueueVerifyDebtPersist` (eventi `verify.debt_open` / `verify.requested` / `verification.run` sulla stessa persist chain). P2a-2 segue quel pattern, non ne inventa uno.

## Seams verificati (righi 1-based, taskTool.ts salvo nota)

| Seam | Righe | Stato |
|---|---|---|
| `permissionsForTaskAgent` | ~152–162 | verify: read+execute+network (difendibile, da documentare) |
| `GENERAL_PROMPT` | ~251–258 | stub: 6 righe / ~432 char |
| `VERIFY_PROMPT` | ~260–282 | chiede `<verify-report>` come finale |
| `buildTaskAutoVerifyPrompt` | ~622–669 | chiede `VERDICT:` come ULTIMA riga (conflitto ↑) |
| `runAutoVerifyAfterGeneral` / `runVerify` / rework | ~749+ / ~833 / ~871 | `thoroughness: 'medium'` hardcodata ×2 |
| cattura usage (message_end) | ~1215–1232 | provider-reported, sommata per turno — nessun consumatore |
| footer risultato parent | ~2208 | `[sub-agent:kind/thoroughness model=X]` + result + footer (solo worktree) |
| branch `agent === 'verify'` (parseVerifyReport) | ~2185–2207 | consuma `<verify-report>` solo se `krakenRequiredChecks()` non vuoto |

Non verificati oggi (verificare in BUILD, ipotesi): posizione del gate cap per-turn (~2112?), mappa budget per kind (ricerca: explore 4/6/12, general 8/12/20, verify 6/10/14), costruzione esatta di `res.footer`.

## Vincoli trasversali

- Zero nuovi kill-switch/env. Nessun default di sicurezza girato.
- Moduli nuovi: uno per file, ≤300 LOC. `taskTool.ts` non cresce: si estrae.
- Nessun bump di `SESSION_SCHEMA_VERSION` senza esplicito assenso utente (stop rule di P2a-2).
- Trailer `VERDICT:` resta: è contratto dell'executor rework.
- Convenzione repo: commit atomici per slice, test verdi prima del claim.

---

## P1a — GENERAL_PROMPT serio (t153, high)

**Goal.** L'unico kind che modifica il repo smette di avere il prompt più corto dei tre.
**Scope.** Nuovo `src/cli/tools/taskPrompts.ts` (esporta `EXPLORE_PROMPT`, `GENERAL_PROMPT`, `VERIFY_PROMPT`); `taskTool.ts` importa. Fuori: runtime, permessi, budget.
**Fare.** GENERAL_PROMPT passa da 6 a ~15–20 righe: read-before-write (snapshot/anchor prima dell'edit, apply esatto, errore strutturato se mismatch — allineato ad ADR-0033), edit minimi e mirati, formato di ritorno obbligato (cosa è cambiato / file toccati / rischi / come verificare), worktree discipline, niente nested spawn, niente scope creep.
**Accettazione.** Test nuovo `taskPrompts.test.ts`: GENERAL_PROMPT contiene le sezioni edit-integrity e return-format, lunghezza entro bound (~1800 char); i tre prompt restano stringhe pure esportate; test taskTool esistenti verdi (nessun comportamento runtime cambiato — è solo testo).
**Rollback.** Revert del solo commit: nessuna dipendenza da altri slice.

## P1b — Contratto verify composto (t154, high)

**Goal.** Il tentacolo verify riceve UNA istruzione di formato finale, non due in conflitto.
**Scope.** `buildTaskAutoVerifyPrompt` in taskTool.ts; allineamento mirato di `buildAutoVerifyPrompt` in `src/cli/kraken/planner.ts` (~845) se ha lo stesso stacking. Fuori: `parseVerifyVerdict`, executor rework loop, semantiche `unknown`.
**Fare.** Il task prompt chiede: "termina con i blocchi `<verify-report>` richiesti dalle tue istruzioni, SEGUITI da una riga finale `VERDICT: PASS|FAIL`". I due formati compongono invece di competere. `parseVerifyVerdict` invariato (last-trailer-wins già gestisce il trailer dopo i blocchi).
**Accettazione.** Test in `taskTool.verifyReport.test.ts`/`verifyDebt`: (1) output simulato con blocchi verify-report + trailer finale → verdict parse-ato E report parse-abile; (2) trailer assente → resta `unknown` (semantica invariata); (3) planner produce lo stesso ordine compose. Suite `kraken/executor`/`verificationBridge` verde.
**Rischio.** Basso: si cambia solo testo del prompt e si mantiene ogni parser.

## P1c — Auto-verify onesta (t155, high)

**Goal.** Thoroughness non hardcodata; accounting spawn esplicito.
**Scope.** `runAutoVerifyAfterGeneral` (runVerify ~833, rework ~871). Fuori: budget general per-turn, cap gate stesso.
**Fare.**
1. `thoroughness` del verify interno eredita quella del general padre (`opts.general.thoroughness`, già in TentacleSuccess). Rework: idem o `medium` documentato.
2. Verificare in BUILD dove vive il gate cap per-turn (~2112?): se l'auto-verify chain (verify + ≤1 rework) non conta in nessun bucket, documentarlo nel commento come catena-obbligazione limitata (≤2 spawn) — NON aggiungerla al bucket general (rischio deadlock sui turni multi-general). Se invece conta già, solo il commento.
**Accettazione.** Test: inner verify riceve thoroughness del padre (quick→quick, deep→deep); suite activity/progress/verifyDebt verde; commento di accounting aggiornato.
**Rischio.** Medio-basso: cambiare quando/deep gira l'auto-verify può allungare i tempi — mitigato dal fatto che eredita, non aumenta.

## P2a-1 — Usage nel footer del risultato (t156, high — catalizzatore)

**Goal.** I token già misurati (~1215–1232) arrivano al padre.
**Scope.** Nuovo `src/cli/tools/subagentMetrics.ts` (formattazione footer); taskTool.ts: estende `res.footer` alla ~2208. Fuori: spine, doctor, radio (sono P2a-2).
**Fare.** Riga metriche nel footer parent-facing: `metrics: {prompt, completion, cached, total} tokens · N tool calls · M turns` (dati già in mano al loop; turns = contatore messaggi, toolCalls = toolTrace.length). Sempre onesta: se usage assente (provider che non lo riporta), niente riga, nessuna approssimazione.
**Accettazione.** Test: tentacle successo con usage → footer contiene la riga; usage assente → footer senza riga e senza `0 tokens` inventato; footer worktree esistente non regresso (worktreeFallback.test).
**Nota.** Questo è il prerequisito dei flip data-gated K5.3: senza consumatore quei numeri non esistono.

## P2c — Guard anti-loop (t157, medium-high)

**Goal.** Il fallimento osservato in ricerca (tentacolo MiniMax-M3 che ripete la stessa frase ~30× fino a budget) diventa stop onesto.
**Scope.** Nuovo `src/cli/tools/subagentLoopGuard.ts` + hook nel tool-loop di taskTool.ts (message_end ~1228). Fuori: retry automatici, env, politica turni.
**Fare.** Pure function: tiene gli ultimi 3 messaggi completi normalizzati (lowercase, whitespace collapse, token multiset); se 3 consecutivi con similarità ≥0.9 → abort del tentacolo con risultato onesto `[sub-agent stopped: degenerate loop detected at turn N]` + partial result se esiste. Default ON, zero env, sempre visibile nel footer (mai taglio muto).
**Accettazione.** Unit test su `subagentLoopGuard.test.ts`: loop identico → trigger al 3°; contenuti alternanti/diff identici ripetuti → nessun falso positivo (i tool result non contano, solo i messaggi assistant); test integrazione nel loop simulato.
**Rischio.** Falsi positivi su ripetizioni legittime: mitigato da soglia conservativa e dal fatto che il partial result sopravvive.

## P2b — Budget scalati per thoroughness + marking "partial" (t158, medium)

**Goal.** quick/medium/deep smettono di avere lo stesso tetto di turni dentro lo stesso kind.
**Scope.** Mappa budget per kind in taskTool.ts (individuare in BUILD: ricerca dice 4/6/12, 8/12/20, 6/10/14) + descrizione tool.
**Fare.** Moltiplicatore thoroughness sui turni (quick ~0.6×, medium 1.0×, deep ~1.6×; allineare a convenzioni kraken esistenti se le trova). La descrizione del tool `task` marca i vincoli "partial/best-effort" (stile docs competitor) invece di implicarli garantiti.
**Accettazione.** Unit test su resolveBudget(kind, thoroughness); descrizione aggiornata; suite taskTool verde.
**Dipendenza.** Dopo P2a-1: i numeri del footer dicono se i moltiplicatori sono giusti.

## P2a-2 — Metriche su spine + osservabilità sessione (t159, medium)

**Goal.** Le metriche per-tentacolo diventano evento durevole e query-abili.
**Scope.** Pattern `verifyDebtSpine.ts`: nuovo evento additive (es. `subagent.metrics`) sulla stessa persist chain, payload: agentId, kind, thoroughness, model, promptTokens, completionTokens, cachedPromptTokens, totalTokens, toolCalls, turns, durationMs. Opzionale se a costo zero: riga di sintesi in `session`/`--doctor`.
**Fare/Stop-rule.** Additive-only: `SCHEMA_VERSION` invariato e replay tollerante verificato con i test spine esistenti (`verifyDebtSpine.test.ts`). Se il vocabolario eventi richiede bump di schema → STOP e chiedi all'utente, non improvvisare.
**Accettazione.** Evento emesso per un tentacle reale in test; replay di una sessione con l'evento nuovo non fallisce su versione corrente; nessun consumer rotto.
**Dipendenza.** Dopo P2a-1 (stessa fonte dati).

## P3 — Advertise policy per-kind + audit rete verify (t160, low)

**Goal.** Ogni tentacolo conosce la propria gabbia; la rete del verify è documentata, non un mistero.
**Scope.** Una riga per prompt in `taskPrompts.ts` (dopo P1a): explore "read-only, no writes/exec"; general "full tree access in scope"; verify "read/execute/network — network serves bash installs (npm), never trust implementer summaries". Commento su `permissionsForTaskAgent` con la ratio rete=verify.
**Fare.** Solo testo e commenti. Nessun flip di permessi.
**Accettazione.** Test prompt-content; `taskTool.activity`/`planSafety` verdi.

---

## Ordine di esecuzione in BUILD

Serie sullo stesso file, un tentacolo `general` per slice, commit atomici:

1. **t153** P1a → 2. **t154** P1b → 3. **t155** P1c (P1 in sequenza stretta: stesso file, stessa area)
4. **t156** P2a-1 (catalizzatore) → 5. **t157** P2c → 6. **t158** P2b → 7. **t159** P2a-2 → 8. **t160** P3

Dopo ogni slice: `npx vitest run src/cli/tools/` + typecheck. Prima di chiudere il giro: `npm run gate-full`. P2a-2 in più: suite spine (`verifyDebtSpine.test.ts`, `session validate`).

## Fuori scope (non riaprire)

K2.6/K3.7 (ritirati), nesting/resume/memory per sub-agent (scelta deliberata, non debito), marketplace/plugin, t149 engine A, kill-switch nuovi, jail Windows.

## Rischi riassunti

| Rischio | Slice | Mitigazione |
|---|---|---|
| Trailer VERDICT rotto per l'executor | P1b | parser invariato; test executor/bridge obbligatori |
| Auto-verify più lenta (thoroughness ereditata deep) | P1c | eredita, non amplifica; osservabile col footer P2a-1 |
| Falsi positivi loop-guard | P2c | soglia 0.9×3, solo messaggi assistant, partial result conservato |
| Bump schema spine non autorizzato | P2a-2 | stop-rule esplicita: chiedere all'utente |
| taskTool.ts cresce invece di restringere | tutti | estrazione moduli (taskPrompts, subagentMetrics, subagentLoopGuard) |
