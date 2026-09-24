# Diagnosi e piano di fix — tentacoli muse perdono gli args dei tool

**Data:** 2026-09-24 · **Stato:** DIAGNOSI COMPLETATA (evidenza su disco), fix da implementare in BUILD.
**Sintomo(segnalazione):** tutti i tentacoli explore degradati ("parametri tool non trasmessi", zod `expected string, received undefined`).

## 1. Sintomo (riprodotto live)

Tentacolo diagnostico spawnato apposta (sessione radio `3726a8ab`, 10:25:35Z, modello `muse-spark-1.3-contributor`):

- `read_file {path:"package.json"}` → errore Zod verbatim: `Invalid input: expected string, received undefined` su `path`.
- `list_files {path:"src/cli/kraken", maxDepth:1}` → **nessun errore**, ma elenca la root (46 entries): `path` arrivato `undefined` → default working dir.
- Il sub-agent ha emesso gli args corretti (li riporta identici nel suo contesto); vengono azzerati **prima** dell'esecuzione del tool.

Storico radio: **5/5 run muse degradati** in modo identico e deterministico (4× `234a0b71` 10:20–10:22, 1× `3726a8ab` 10:25). Tentacoli su altri modelli completano (es. `mimo-v2.6-flash`, verify K4.1, 23/09). Il canale di delega in sé è sano.

## 2. Catena causale (evidenza su file)

1. **Routing:** `src/cli/provider/resolveStream.ts:20` — `providerId === 'muse'` → `responsesApiProvider` (muse è "Responses-compatible", base `https://api.meta.ai/v1`, vedi `museOAuth.ts`).
2. **Accumulo args:** loop SSE in `src/cli/provider/responsesApi.ts` (~righe 236–262). Gli args si accumulano SOLO da:
   - `response.output_item.added` → `argsJson = item.arguments` **solo se `typeof === 'string'`** (altrimenti `''`);
   - `response.function_call_arguments.delta` → concatenazione per `item_id`.
   - `response.output_item.done` (riga ~255) fa solo `flush(id)`: **ignora `item.arguments` completo**.
   - L'evento `response.function_call_arguments.done` (args completi) **non è gestito affatto**.
3. **Parse permissivo:** `src/cli/provider/toolArgs.ts` — payload vuoto → `{}` senza errore (zero-arg legittimo, by design K4.1) ⇒ il degrado è **silenzioso**: `args = {}` passa lo schema solo se tutti i parametri sono opzionali.
4. **Effetto:** tool con required → Zod `expected string, received undefined`; tool solo-opzionali → eseguono coi default. Il `toolName` arriva (il tool parte), gli args no.

**Ipotesi sul dialetto muse** (H1, da confermare col frame dump — vedi F2): muse recapita gli args in un canale che l'adapter ignora. Tre varianti coperte dal fix:
- H1a: solo `output_item.done.item.arguments` (full string), nessun delta;
- H1b: evento `response.function_call_arguments.done` senza/accompagnato da delta;
- H1c: `item.arguments` come oggetto JSON già parsato (non stringa).

Nota: `chatgpt.ts` (~riga 204) ha un **loop identico** con la stessa debolezza latente — con OpenAI reale non emerge perché i delta arrivano; il fix va fatto in entrambi per mantenere il contratto condiviso.

## 3. Gap secondari emersi

- **Osservabilità:** nessun dump dei frame provider nel runtime (grep su `packages/core/src/runtime`: zero match); senza di esso questa diagnosi ha richiesto un tentacolo-repro. 
- **Radio bugiarda:** i `done` dei tentacoli degradati sono registrati `ok:true` — il degrado non è misurabile dal progress bus.
- **Coverage:** lo smoke live muse (2.63.1, `ZELARI_MUSE_LIVE=1`) streamma solo una completion, mai una tool call.

## 4. Piano di fix (ordine di esecuzione)

### F1 — Merge args dai canali "done" nel loop Responses (nucleo)
File: `src/cli/provider/responsesApi.ts`, `src/cli/provider/chatgpt.ts` (loop gemello).
1. Ramo `response.function_call_arguments.done` (nuovo): se entry esiste e `argsJson === ''` e `typeof ev.arguments === 'string'` → assegna.
2. Ramo `response.output_item.done`: oltre a `flush(id)`, se entry esiste e `argsJson === ''` e `item.arguments` è stringa non vuota → assegna prima del flush.
3. Coercizione oggetto: se `item.arguments`/`ev.arguments` è oggetto non-null (H1c) → `JSON.stringify` prima di assegnare (solo quando `argsJson` è vuoto).
Sicurezza per OpenAI reale: si scrive **solo a argsJson vuoto**; con il streaming a delta (done ≡ concatenazione dei delta) il comportamento resta byte-identico.

### F2 — Frame dump opt-in (conferma H1 + diagnosi future)
Env `ZELARI_PROVIDER_FRAME_DEBUG=1`: nel loop Responses (e chatgpt), append su stderr di `ev.type` + shape sintetica degli args (string len / typeof) per gli eventi function_call. Zero overhead a flag spento. Serve anche da **step 0** di verifica ipotesi prima/durante F1.

### F3 — Guardia anti-degrado silenzioso (small, opzionale)
Al `flush`, se `argsJson` resta vuoto ma lo schema del tool (`params.tools[].parameters.required` è già disponibile all'adapter) ha `required` non-vuoto → `{kind:'error'}` con guard code `tool_args_missing` (famiglia K4.1 `tool_args_parse_failed`). Trasforma il bug-classe "args persi" in errore visibile invece di zod-error criptici o default silenziosi.

### F4 — Radio honest (rinviato, task separata)
Il `done` event dovrebbe riportare il degrado (`ok:false` o flag dedicato) quando un tentacolo riporta guasti strumentali. Fuori dallo scope di questo fix; aprire task ad hoc.

## 5. Test

- `src/cli/provider/responsesApi.test.ts`: nuovo caso "muse dialect" — `added(args:'')` **senza** delta + `done(args:'{"path":"a.ts"}')` → `tool_call` con args corretti; caso `function_call_arguments.done` senza delta; regressione streaming OpenAI (delta + done con stessa stringa) byte-identica, nessuna duplicazione.
- `src/cli/provider/toolArgs.test.ts`: estendere la matrice chatgpt+responsesApi con i canali done.
- Live (dopo fix): tentacolo diagnostico `read_file package.json` → atteso `version: 2.63.1`; opzionale estendere lo smoke `ZELARI_MUSE_LIVE=1` con una tool call.

## 6. Verifica (BUILD)

```
npx vitest run src/cli/provider/responsesApi.test.ts src/cli/provider/toolArgs.test.ts
npm run typecheck
# live: spawn tentacolo explore con read_file package.json
```

## 7. Mitigazione immediata (oggi, senza codice)

Puntare il sub-model dei tentacoli su un modello non-muse (`ZELARI_KRAKEN_SUB_MODEL` / config provider) finché F1 non è mergiato.

## 8. File coinvolti

- `src/cli/provider/responsesApi.ts` (F1, F2, F3)
- `src/cli/provider/chatgpt.ts` (F1, F2 — loop gemello)
- `src/cli/provider/responsesApi.test.ts`, `src/cli/provider/toolArgs.test.ts` (test)
- Nessuna nuova dipendenza; modifiche confinate al layer adapter provider.

## 9. Evidenze aggiuntive (riesplorazione log sessione `234a0b71`, 2026-09-24)

La sessione di BUILD è terminata con `session.ended reason: "cancelled"` (seq 263) **prima di ogni edit**: aveva letto gli anchor file (responsesApi.ts 88–215, chatgpt.ts, responsesApi.test.ts, toolArgs.ts) ed era in `stage: implement`, budget ampio (33 tool call residui). `git status` conferma: nessun sorgente modificato, solo `.zelari/` — **F1–F3 non implementati, t174–t176 pending**.

Catena causale **confermata sul sorgente**:
- `responsesApi.ts:241-260` / `chatgpt.ts:190-209` — loop SSE identici: args solo da `output_item.added` (riga 248/197, solo se stringa) + `function_call_arguments.delta` (251-254 / 200-203); `output_item.done` (255-260 / 204-209) fa solo `flush(id)` **scartando `item.arguments`**; `response.function_call_arguments.done` **non gestito** (grep: zero match in tutto `src/` + `packages/core/src`).
- `toolArgs.ts:45` — payload vuoto → `{ok:true, args:{}}` → degrado silenzioso per design K4.1.
- `resolveStream.ts:17` (non :20 come da citazione iniziale — drift minore).

Nuovi effetti collaterali osservati:
1. **Amplificazione doom-loop:** gli args persi fanno fallire la call, il tentacolo la ripete uguale → `[duplicate call — result repeated]` → guard `doom_loop` / `maxToolCallsPerTurn` (t1). Rose:t4 ha bruciato 37 turni / 42 tool call / 339K token per un mapping che ne richiede pochi. F1 toglie la causa; F3 rende il fallimento loud invece di moltiplicare i retry.
2. **Radio bugiarda confermata:** `subagent.metrics` riporta `ok:true` per tutti e 5 i tentacoli (t1–t5) nonostante report "DEGRADED" — F4 resta justified.
3. **Anomalia secondaria orthogonale (non-muse):** seq 93→101, `todo_write` con `merge:true` emesso con soli `{id,status}` → errore Zod `todos[0].content expected string`. In `src/cli/tools/todoTools.ts:22` `content` è always-required anche in merge. Da gestire come task piccola separata (rendere `content` opzionale quando `merge=true`).

## 10. Implementazione (2026-09-24, BUILD)

**Causa radice aggiuntiva (più profonda di H1):** il loop indicizzava le call per `call_id`, ma da spec Responses i frame `response.function_call_arguments.delta|done` referenziano `item_id` = `item.id` (`fc_…`), che è **diverso** da `call_id` (`call_…`). Con un server conforme ogni delta mancava la sua call → args `{}`. I test esistenti usavano lo stesso id per entrambi, mascherando il bug. Colpiva anche `chatgpt.ts`.

Fatto:
- **F1** — loop SSE unificato in `src/cli/provider/responsesSse.ts` (usato da `chatgpt.ts` e `responsesApi.ts`): correlazione per `call_id` + `item.id` + `output_index`; canali `function_call_arguments.done` e `output_item.done` autorevoli quando non vuoti; args-oggetto serializzati; `done` senza `added` non viene più scartato; call pendenti flushate anche su `response.completed`; ultimo frame senza `\n` finale processato; messaggio di `response.failed` estratto da `response.error.message`.
- **F2** — `ZELARI_PROVIDER_FRAME_DEBUG=1`: una riga stderr per evento (tipo, id di correlazione, shape degli args — mai il contenuto).
- **F3** — `tool_args_missing` come errore advisory **senza** scartare la call (va comunque alla validazione Zod → feedback + schema-repair hint al modello; scartarla avrebbe lasciato il modello senza tool result).
- **F4** — `toolErrors` + `toolsDegraded` (additivi) su radio `done`, `subagent.metrics` e risultato del tentacolo; guard line al parent "treat its findings as UNVERIFIED" quando ≥2 errori e ≥50% delle call falliscono. `ok` resta invariato.
- **todo_write** — `content` opzionale solo per patch `merge:true` su id esistenti (status-only); status preservato se omesso in merge; id auto in merge non collidono più con `tN` esistenti; errore azionabile per patch su id sconosciuti.

Verifica: `npx vitest run` 669 file / 6672 test verdi; `npm run typecheck`, `npm run verify:principles`, `npm run build`, `npm run smoke` verdi. Test live (opt-in): `ZELARI_MUSE_LIVE=1 npx vitest run tests/unit/cli-museOAuth.live.test.ts` — nuovo caso "streams a tool call WITH its arguments".
