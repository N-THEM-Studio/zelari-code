# Piano: isolamento chat Desktop su sidecar multiplexato (Fix A–E)

> Stato: piano verificato con 3 explore read-only (Rust sidecar, permessi TS, App.tsx routing).
> Tutte le evidenze file:linea sono state lette dal codice reale (branch corrente, post-2.43.1).
> Task collegati: t59 (Fix A), t60 (Fix B), t61 (Fix C), t62 (Fix D+E).

## 0. Contesto e problema

`harness_sidecar.rs` esegue **un solo** figlio `zelari-code --serve-harness` per tutta la finestra
(`harness_sidecar.rs:1`, `lib.rs:3303`). N run paralleli = N `session.create` sullo stesso stdio.
L'identità di chat non è una chiave di isolamento in 3 punti:

1. **Eventi senza spine `sessionId`** vengono inviati al sink unico se c'è 1 run attivo,
   o **broadcast** a tutti i sink con ≥2 run; ogni copia rietichettata col `conversationId`
   del run ricevente (`route_event` `harness_sidecar.rs:1123-1187`; broadcast `:1170-1186`, `:1223`;
   rietichetta `lib.rs:136-143`, `:3069`). Finestra unbound = `SPINE_BIND_WAIT` 30s (`:135-137`).
2. **`permission.request`/`permission.settled` portano solo `requestId`** (`perm-<ts>-<seq>`),
   niente `sessionId` (`src/cli/serve/permissionBridge.ts` ~150-160 e ~114-119). La `pending`
   Map è keyed per `requestId` (~101): un respond da QUALUNQUE chat della finestra risolve qualunque ask.
3. **Grant e preset sono stato di processo**, non di chat: `sessionToolGrants`/`sessionCategoryGrants`
   module-level (`toolPermissions.ts:49-50`), `ZELARI_PERMISSION_PRESET` in `process.env`
   (`permissionBridge.ts:35,43`, scritto a ogni `run.turn` da `harnessServer.ts:232`).

Aggravante trovata in verifica: `clearSessionPermissionGrants()` è chiamata SOLO dal path TUI
(`conversationContext.ts:67,332`); il Desktop non la chiama mai — `session.dispose`
(`harnessServer.ts:352-358`) non tocca i grant ⇒ sopravvivono al dispose, per tutta la vita del sidecar.

## 0.1 Correzioni rispetto all'analisi originale (utente)

- **Il fallback "chat attiva" NON è stato chiuso dalla 2.42**: `App.tsx:1400-1403` fa
  `readRunEnvelope(ev).conversationId ?? activeIdRef.current`. Non esiste alcun gate-drop né
  log `dropping … no conversationId` nel frontend: gli eventi senza envelope atterrano sulla chat attiva.
- **Con un solo run non c'è broadcast**: righe unbound → direct al sink unico; il fan-out
  richiede ≥2 sink. Effetto pratico in multi-run identico all'analisi.
- Il commento testuale M2 "Writing B's sessionId into A…" non è nel repo; l'invariante sì
  (`types.ts:92-95`, gate `session_started` `App.tsx:1699-1707`).
- localStorage `zelari-desktop-chats-v1` persiste messaggi (tail 200), `sessionId` e `cwd` per chat
  (`chatStorage.ts:11,112-117`): confermato blob unico, ma non mescola messaggi da solo.
- `folderSwitch.ts` a posto (virgin-only rebind, `:30-33`, `planFolderSwitch.ts:48-52`).

## Fix A — sessionId spine sugli eventi permesso (t59, PREREQ di Fix B)

**Obiettivo**: `permission.request`, `permission.settled`, `ask_user.*` escono dal sidecar con
lo spine `sessionId` del run emittente (campo additivo: i vecchi Desktop ignorano campi extra).

- `harnessServer` conosce la sessione corrente del `run.turn`: thread del contesto sessione
  nel bridge (per-server, NON globale) → `onPermissionAsk`/`settle` lo includono nel payload.
- Ext `apps/desktop/src/types.ts:325` (shape `PermissionAsk`).
- Difesa in profondità: `permission.respond` valida la provenienza quando possibile
  (post-Fix B l'ask esiste in una sola chat e `requestId` basta, ma la validazione resta).

**Acceptance**: riga NDJSON `permission.request` su stdout contiene `sessionId` emittente;
test unit bridge (ask/bring/settle con e senza sessione); `npm run typecheck` verde.

## Fix B — whitelist broadcast nel sidecar Rust (t60, dopo Fix A)

**Obiettivo**: il fan-out è vietato per gli eventi semantici. Broadcast ammesso SOLO per tipi
cosmetici (log early MCP, ack di control).

- `route_event` (`harness_sidecar.rs:1123-1187`): per tipi semantici (`assistant`, `tool_*`,
  `permission.*`, `session_started`, `harness_state`, `ask_user.*`) unbound ⇒
  (a) resolve via spine→run map quando lo `sessionId` c'è ma non è mappato; (b) altrimenti
  **drop + log diagnostico**, mai etichettare con un `conversationId` arbitrario.
- Il path single-run (1 sink) resta com'è: non è una contaminazione.
- `harness_state` arriva già normalizzato con spine id hoistato (`:1108-1121`).

**Acceptance**: test Rust di routing unbound per tipo (estendere i test in `harness_sidecar.rs`);
single-run invariato; con 2 run vivi, nessun evento semantico compare in entrambe le chat.

## Fix C — grant permessi per-sessione (t61, indipendente)

**Obiettivo**: `grantSessionTool`/`grantSessionCategory` sono keyed per
`(harnessSessionId | chiave singleton TUI)`, non più Set di processo.

- `toolPermissions.ts`: `sessionToolGrants: Map<string, Set<string>>` con chiave sessione;
  `resolveToolPermission` riceve la chiave dai chiamanti (`toolRegistry.ts:1115,1129`,
  `mcp/brokerHandlers.ts:96`, tutti dentro `run.turn` che ha il contesto).
- **`session.dispose` (`harnessServer.ts:352-358`) chiama `clearSessionPermissionGrants(key)`** —
  oggi i grant sono immortali sul Desktop.
- TUI legacy: `conversationContext.ts` continua a usare la chiave default singleton →
  comportamento attuale invariato (chiama esistenti intatte).

**Acceptance**: grant dato in A non visibile in B nello stesso processo; dispose A non cancella
grant di B; test safety estesi (`policyEngine.test.ts`, `resourceClaims.test.ts`).

## Fix D — preset per-run, non env di processo (t62.1)

- `applyTurnPermissionPreset` smette di mutare `process.env.ZELARI_PERMISSION_PRESET`:
  il preset diventa campo del `run.turn` (input già fluisce da `harnessServer.ts:232`),
  fallback env solo per boot flag. Lettori: `osJail.ts:118-124` via `activePermissionPreset()`.
- Aggiornare copy `PermissionsSection.tsx:34` ("sidecar-wide" non sarà più vero).

## Fix E — harness_state per-conversation + no fallback chat attiva (t62.2)

- Rust: esporre la mappa per-sessione `harness_states` (getter esiste `:395-406`); ritirare
  `last_harness_state` globale (`:317-318`) dal path multi-run.
- Frontend: `useHarnessState.ts:29-31` tiene una `Map` keyed per `conversationId` usando il
  `sessionId` già presente nel payload `harness-state` (oggi scartato in `agentClient.ts:689-699`);
  `KrakenContextPanel.tsx:69` legge lo stato della chat corrente.
- `App.tsx:1403`: rimuovere `?? activeIdRef.current` per eventi semantici (drop+log);
  il fallback resta solo per eventi senza identità noti-cosmetici.

## Ordine di esecuzione e dipendenze

```
Fix A (t59) ──▶ Fix B (t60)      [bloccanti: senza questi, 2 chat parallele non isolabili]
Fix C (t61)                      [indipendente, parallelizzabile con A/B]
Fix D + Fix E (t62)              [chiusura, dopo A/B; D indipendente]
```

Fix A senza Fix B non basta (gli eventi restano fan-out); Fix B senza Fix A dropperebbe
gli ask invece di instradarli. Per questo sono PREREQ reciproci nell'ordine indicato.

## Verifica end-to-end (smoke 2 chat / 2 cartelle)

1. Due chat, due cartelle diverse, entrambe in run.
2. Ask in A: la card compare SOLO in A; `requestId` assente dalla chat B.
3. "Always this tool" in A ⇒ B continua a chiedere per bash (grant non leakano).
4. Yolo in A ⇒ B resta standard (preset non leakano).
5. Meter context in B non mostra l'occupazione spine di A.
6. Nessun testo di A in B; spine di B sotto `progettoB/.zelari/sessions/` con id proprio.
7. `session.dispose` A ⇒ grant di A spariti; grant di B intatti.

## Rischi

- Campo additivo su `permission.*`: backward/forward compatible (vecchi peer ignorano campi extra) — basso.
- Drop di eventi unbound: se un evento semantico legittimo resta senza spine id per bug a monte,
  scompare invece di finire nella chat sbagliata — accettabile, con log diagnostico esplicito.
- Keying grant: tutte le call-site di `resolveToolPermission` devono ricevere la chiave;
  il default singleton protegge la TUI ma va annotato come deprecato.

## 6. Stato implementazione (2026-09-15, follow-up)

Completati in coda al turno principale, verificati su disco:

- **Shape estese TS** — `apps/desktop/src/types.ts`: `sessionId?: string` su
  `permission.request` / `permission.settled` / `ask_user.request` / `ask_user.settled`.
- **Irrigidimento difensivo del bridge (nuova falla trovata dai test)** — un respond
  *con scope* poteva ancora settlare un ask *unscoped* (guardia `entry.sessionId &&`
  permissiva in `respond`, guardia `sessionOf() &&` in `servePermissionRespond`).
  Nessun host legittimo produce quel caso (Rust manda scope solo per ask registrati
  con sessione), quindi ora entrambe le guardie rifiutano con `session_mismatch`.
  `src/cli/serve/permissionBridge.ts`.
- **Test di scope** — `src/cli/serve/permissionBridge.scope.test.ts` (6 test):
  stamp sessionId su request/settled, respond cross-session rifiutato e ask resta
  pending, legacy unscoped funzionante, scope-su-unscoped rifiutato, `releaseGranted`
  rispetta lo scope, bucket grant isolati + clear selettivo.

Verifica finale: vitest serve+safety 140 pass + 6 scope; `tsc --noEmit` CLI e
Desktop exit 0; `cargo test --lib harness_sidecar` **18 passed** (i test Rust ora
girano — il limite DLL del turno precedente non si è ripresentato).

Residuo: solo lo smoke manuale §5 (2 chat / 2 cartelle con UI Tauri).
