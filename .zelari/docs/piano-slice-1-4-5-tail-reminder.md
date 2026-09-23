# Piano BUILD — slice 1, poi 4; 5 in parallelo

Stato: ipotesi di implementazione ancorata al tree il 2026-09-22. Non è prodotto shipped.
Non batte Claude Code né chiude il daily-driver. Chiude un solo contratto: il testo volatile che il modello legge esce da un assembler, e il reminder ci entra solo dopo.

Fuori da questo piano, anche se nominati prima: bench competitivo, ACP, allargamento hook, marketplace, t149, fusione di council/mission/grafo, jail Windows, allineamento dei due worktree.

## Fatto già vero (non rifare)

- TUI parte in Kraken: `src/cli/app.tsx` (`useState<ChatMode>('kraken')`).
- Strict-done è ON. Opt-out: `ZELARI_STRICT_DONE=0`, `ZELARI_MISSION_STRICT=0`.
- Isolamento dei tentacoli `general`: `resolveKrakenWorktreeMode` in `src/cli/tools/krakenWorktree.ts` — unset → ON. Opt-out: `ZELARI_KRAKEN_WORKTREE=0`.
- Scheduler diverso, non da allineare: `resolveWorktreeMode` in `src/cli/kraken/worktreeScheduling.ts` — unset → `off`. Due funzioni, due default.
- `buildSystemReminder` è puro e completo (`packages/core/src/core/modules/system-reminder/systemReminder.ts`). Default acceso. Spento solo da `ZELARI_SYSTEM_REMINDER=0`.
- `docs/CAPABILITIES.md` riga ~40: system reminder `planned`. Vero.
- `CHANGELOG.md` riga ~158: lo dichiara iniettato nel projection seam. Falso. Si corregge nello slice 4, a test verde, non prima.
- `AgentHarness.messagesForProvider` (`packages/core/src/core/AgentHarness.ts` ~1422) ha `TODO(seam)`. Non cablare il reminder lì.

## Vincolo che il piano precedente sbagliava

`buildModelContext` calcola `requestTail` una volta, dallo snapshot passato in input (`modelContextBuilder.ts` ~136). L'harness no: `requestTail` è una freccia chiamata dopo, dentro `messagesForProvider`, e rilegge `latestResourceSnapshot()` all'invio (`useChatTurn.ts` ~941, `runOneTurn.ts` ~652). `onePager.ts` documenta i due usi: occupancy nel builder, freccia lazy perché il modello lo veda fresco.

Non sostituire la freccia con `result.requestTail` congelato. Estrarre un solo assembler e chiamarlo da entrambi i momenti.

## Slice 1 — un assembler, frecce lazy

Obiettivo: status + one-pager non sono più letterali duplicati. Un funzione li concatena. Le frecce restano lazy.

File:

- `src/cli/budget/modelContextBuilder.ts` — estrarre `assembleRequestTail`. `buildModelContext` la chiama al posto del letterale ~136. Ordine invariato: `resourceStatusTail(snapshot)` poi `volatileOnePager`.
- `src/cli/hooks/useChatTurn.ts` ~941 — la freccia chiama l'assembler con lo snapshot fresco e lo stesso `onePager` già passato al builder.
- `src/cli/headless/runOneTurn.ts` ~652 — identico.
- Audit, non fusione: `useChatTurn.ts` ~1777 (council TUI), `src/cli/runHeadless.ts` ~1035 (council) e ~1395 (mission). Chiamano `buildModelContext` e usano `.history` / `.budget`. Non costruiscono `AgentHarness` con `requestTail`. `runHeadless.ts` importa `resourceStatusTail` senza call site oltre l'import: confermare e, se inutilizzato, togliere solo quell'import.
- Il grafo Kraken, se entra da `runOneTurn`, è coperto. Non aggiungere un terzo assemblaggio.

Council e mission restano eccezioni nominate. Commento di una riga sul call site: il tail volatile non entra in `dispatchCouncil` / mission; non copiare `requestTail` dentro `setHistory` (finirebbe in history). Non rewire del prompt council in questo slice.

Accettazione:

- I test esistenti di `modelContextBuilder.test.ts` restano verdi, compreso l'ordine RESOURCE STATUS poi WORKING SET.
- Un marker inserito solo nell'assembler compare in `result.requestTail` e in ciò che restituisce la freccia dei due host.
- Il marker non compare in `result.history`.
- Grep: i due `requestTail: () =>` non contengono più lo spread letterale di `resourceStatusTail` + one-pager.
- Nessun default di sicurezza cambiato.

Fuori: reminder, `AgentHarness`, ACP, hook, t149.

## Slice 4 — reminder sull'assembler (dipende da 1)

Non iniziare se lo slice 1 non ha i test verdi.

Non riscrivere `systemReminder.ts`. Chiamarlo dall'assembler, dopo status e one-pager, mai in `history`.

Input, già nel modulo, da non reinventare:

- Cadenza 5 (`DEFAULT_CADENCE_TURNS`). `turnsSinceLastReminder` è dell'host.
- TUI: ref di sessione in `useChatTurn`, incrementato a ogni turno utente. Se il testo non è `null`, l'host azzera il contatore dopo l'append. Non sulla spine. Non nel prompt precedente.
- `runOneTurn` one-shot: contatore 0 → `null`. Corretto. Non farlo sparare sempre. Se un loop headless in-process richiama più turni, il contatore sta nel loop, non in un globale di modulo.
- Todo: `listSessionTodos()` in `src/cli/sessionTodos.ts`, solo `pending` e `in_progress`, campo `content`. Non `formatTodosForModel` (include completed/cancelled). Non `.zelari/plan.json`.
- Budget: `budgetRemainingPct = (1 - occupancy) * 100` dal budget già calcolato dal builder, passato nella closure della freccia. Omittere se non finito. Il modulo aggiunge la riga solo sotto il 50%.
- Kill-switch esistente. Nessun secondo env.
- Marcatore `[system-reminder]`. Max 5 righe, poi `+N more` — già nel modulo.

Test da aggiornare: `requestTail.at(-1)` che oggi si aspetta WORKING SET. Con reminder presente, l'ultimo è il reminder; senza reminder l'ordine di oggi resta. Test del builder: marker nel tail, assente da history, kill-switch, cadenza non raggiunta, zero todo aperti. Test dell'assembler chiamato dalla freccia, non un test Ink.

Doc, solo a test verde:

- `docs/CAPABILITIES.md` ~40: `planned` → `shipped`, con il path dell'assembler.
- `CHANGELOG.md` ~158: la riga che lo dava già cablato si corregge. Non anticiparla nello slice 5.
- Il `TODO(seam)` in `AgentHarness.ts` può dire che il seam è l'assembler CLI. Non implementare lì.

## Slice 5 — happy path, zero flip (parallelo a 1, non al changelog)

File: `docs/GUIDA.md`.

- Un paragrafo sotto `### Kraken (default)` (~244): si apre Kraken; strict-done è acceso salvo `ZELARI_STRICT_DONE=0`; il worktree dei `general` è acceso salvo `ZELARI_KRAKEN_WORKTREE=0`; su Windows non c'è jail OS (puntare a `docs/CAPABILITIES.md`, non descrivere un workaround).
- Appendice corta in `## Environment variables` (~1479): kill-switch che un utente incontra, raggruppati (sicurezza, orchestrazione, memoria). Non le variabili solo di test. I due worktree restano due voci diverse.
- README: toccare solo se contraddice questi default. Niente secondo saggio.

`AGENTS.md` riga 55, ADR-0033 «implementation in progress»: cambiare la frase solo dopo aver verificato sul tree che il path di edit di default è snapshot + apply esatto + errore strutturato. Se non lo è, lasciare la frase. Non promuoverlo dal titolo dell'ADR.

Non fare: accendere evolution, memory MCP, `ZELARI_COUNCIL_CAN_BUILD`, compact LLM. Non spostare il default di `resolveWorktreeMode`. Non inventare un jail Windows. Non scrivere in `docs/EVALS.md` che abbiamo raggiunto Claude.

Accettazione: un lettore nuovo sa avviare il CLI e sa cosa è opt-out. Nessun default di sicurezza è cambiato. Changelog, CAPABILITIES e codice non si contraddicono sul reminder — questa riga aspetta lo slice 4.

## Ordine e stop

1, poi 4. 5 in parallelo, tranne changelog e CAPABILITIES del reminder. Stop dopo 4 se i test del tail non sono verdi: non si documenta un campo che la freccia non chiama.

Verifica di slice: test del builder + typecheck dei file toccati. Non lanciare la suite intera come definizione di done se il delta è locale; non dichiarare done senza i test del assembler verdi.
