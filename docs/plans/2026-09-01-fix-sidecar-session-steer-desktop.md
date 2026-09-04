# Piano di fix — Sidecar Desktop, sessioni spine, steering e diagnosi

**Data:** 2026-09-01
**Baseline:** zelari-code 2.20.0
**Origine:** sessione di diagnosi su repo + due PC puliti + Desktop in dev
**Stato:** proposta operativa, pronta all'esecuzione

---

# 1. Contesto

La diagnosi ha isolato sei difetti accertati (più uno minore), tutti riprodotti o
verificati a livello di codice, con evidenza ai file. I sintomi utente erano:

- Desktop: "il modello non risponde mai" su macchine pulite (CLI ok, Desktop no).
- Desktop: `sidecar_died: harness sidecar exited unexpectedly (status: 1)`.
- Desktop: resume di una vecchia sessione → "l'agente parte ma si blocca senza
  fare il richiesto".
- Desktop: il cambio cartella "si porta appresso la sessione" del progetto
  precedente (contaminazione cross-progetto).
- `zelari-code --doctor` dà OK con Node 20.20.1 nonostante `engines.node >= 24`.

Causa-radice della famiglia "non risponde": **nessun bug di rete o di
installazione** — una combinazione di (a) agente che può uccidere il proprio
processo host, (b) lock della session spine senza check di liveness, (c) errori
del sidecar invisibili nella UI perché il frontend non ascolta gli eventi che il
backend già emette.

---

# 2. I fix

Ordinati per priorità di esecuzione (P0 → P2). Ogni fix = un commit atomico
(convenzione repo: single-task atomic commits, conventional commits).

---

## FIX-1 (P0) — Guard anti-self-kill nel tool bash/exec

**Problema.** Un agente può eseguire `taskkill //IM node.exe //F` (o per PID
enumerati) e uccidere il processo che lo ospita: la TUI, o il sidecar
`--serve-harness` del Desktop. Riprodotto il 2026-09-01: l'agente, per fermare
un preview server Vite sulla porta 4173, ha fatto taskkill di *tutti* i
node.exe → `sidecar_died (status: 1)`, log senza stacktrace (uccisione esterna
a freddo), supervisor esauriti i 5 restart → silenzio totale.

**Evidenza.**
- Comando letale registrato nella spine:
  `E:/EasyPeasy/giocoandrea/.zelari/sessions/921987c9-…/events.jsonl` seq 1261.
- Il tool bash esegue senza alcun filtro: `src/cli/tools/` + `src/cli/safety/`.

**Soluzione.**
1. Nuovo modulo `src/cli/safety/selfKillGuard.ts`: matcher sui comandi
   spawnabili che:
   - targetizzano l'immagine `node.exe`/`node` per nome (`taskkill`, `Stop-Process`,
     `ps -W | grep node` + `kill`, `pkill -f node`, `wmic process … delete`);
   - targetizzano PID dell'albero proprio: `process.pid`, parent PID chain
     (fino al PID del sidecar/TUI), PID dei worker thread e dei child attivi
     del tool registry.
2. Il guard **rifiuta** con un errore tool-result che insegna l'alternativa
   sicura: kill **per porta** (`netstat -ano | findstr :<port>` → `taskkill //PID
   <pid-listener>`), mai per nome immagine.
3. Copertura sia `bash` che `exec`-like (stessa pipeline di spawn).

**Test.** Unit sul matcher (pattern taskkill/Stop-Process/pkill, casi negativi
con PID specifico di un listener non-self); test di integrazione che il
tool-result di denial contenga la istruzione per-porta.

**Commit:** `fix(safety): block self-kill patterns targeting the agent host process tree`

---

## FIX-2 (P0) — Spine writer.lock: takeover per liveness + heartbeat + sweep + visibilità

**Problema.** Il lock della session spine è solo temporale: un lock orfano con
PID **morto** ma più recente di 10 minuti blocca il resume
(`SessionLogLockedError`) anche se il proprietario non esiste più. Il caso
`locked` poi degrada **in silenzio** (nessun warning, nessun evento): il turno
riprende senza contesto derivato, senza epoch/budget — l'utente vede "l'agente
parte ma si blocca / non fa il richiesto". Riprodotto con script dedicato
(lock con PID morto → `SessionLogLockedError`; solo dopo 11 minuti takeover).

**Evidenza.**
- `packages/core/src/session/writer.ts:100-112` — `stale = now - ts > 10min`,
  `pid` scritto nel lock ma mai usato.
- `src/cli/sessionSpine.ts:306-309` — il ramo `locked` non emette warning
  (solo `degraded` chiama `warnOnce`).
- Trigger reali: taskkill (FIX-1), watchdog `turn_timeout` che fa kill-tree
  mentre il turno tiene il lock (`harness_sidecar.rs:662-669`, commento esplicito),
  crash/riavvio del Desktop a turno in corso.

**Soluzione.**
1. **Liveness takeover** in `SessionLogWriter.acquireLock` (writer.ts):
   lock non-stale → leggi `pid` → probe `process.kill(pid, 0)`:
   - PID inesistente → takeover immediato;
   - PID esistente ma heartbeat fermo (vedi punto 2) oltre soglia → takeover;
   - fallback finale: regola temporale a 10 minuti (invariata).
2. **Heartbeat**: il writer aggiorna `ts` in `writer.lock` a ogni `append()`
   (o al massimo ogni N secondi): distingue un owner vivo da un PID riusato
   (riuso PID su Windows: mitigato dal heartbeat, non eliminabile del tutto).
3. **Sweep a boot del sidecar**: all'avvio di `runHarnessServer()` scan di
   `.zelari/sessions/*/writer.lock` — orfani per liveness/heartbeat → takeover.
   Cura il caso crash→restart prima che l'utente riprenda la sessione.
4. **Visibilità**: ramo `locked` → `warnOnce` (parità con `degraded`) + evento
   note sul canale NDJSON così il Desktop può mostrare "sessione ripresa in
   modalità degradata (lock orfano)".

**Test.** Unit writer: takeover con PID morto, rigetto con PID vivo e heartbeat
fresco, takeover con PID vivo ma heartbeat fermo, staleness >10min. Unit sweep.
Unit warn su `locked`.

**Commit (suddiviso):**
- `fix(core): spine writer lock takeover by owner liveness + append heartbeat`
- `feat(cli): sweep orphan session spine locks at harness server boot`
- `fix(cli): surface locked-spine degradation with warning + NDJSON event`

**Nota rimedio utente (finché il fix non è out):** cancellare a mano
`.zelari/sessions/<id>/writer.lock` o attendere 10 minuti.

---

## FIX-3 (P0) — Desktop: cambio cartella = nuova chat, mai riuso della sessione

**Problema.** `pickFolder` ribinda il `cwd` della conversazione attiva ma
mantiene `sessionId` (spine) e `messages`. Al messaggio successivo il turno fa
`resumeSessionId=<spine progetto A>` contro `<cartella B>/.zelari/sessions/` →
la spine riparte silenziosamente da zero **e** il fallback legacy riversa le
ultime 16 chat del progetto A come contesto dell'agente che lavora in B.
Contaminazione cross-progetto confermata a livello di flusso completo.

**Evidenza.**
- `apps/desktop/src/App.tsx:2449-2462` — `pickFolder` cambia solo `cwd`.
- `apps/desktop/src/App.tsx:1199-1210` — `sessionId` catturato da
  `session_started`, mai resettato.
- `apps/desktop/src/App.tsx:2289` — `send()` passa `sessionId: live?.sessionId`
  + `cwd: activeCwd`.
- `packages/core/src/session/store.ts:25-31` — sessions dir workspace-relativa.

**Soluzione (comportamento scelto).**
1. Se la conversazione attiva è **vergine** (nessun messaggio, nessun
   `sessionId`): ribinda il `cwd` in place (comportamento attuale, corretto).
2. Se invece ha messaggi o `sessionId`: `pickFolder` crea una **nuova
   conversazione** legata alla nuova cartella e la seleziona; la vecchia resta
   nella lista col suo progetto. `workdir` globale aggiornato come oggi.
   - Aggiornare la chat attiva non è un'opzione: ogni ibrido (mantenere
     messaggi e/o sessionId con un'altra root) ricade nella contaminazione.
3. Mostare il folder della conversazione nella sidebar (sub-heading) per
   disinnescare la confusione UI segnalata.

**Test.** Unit/it su `pickFolder` (vergine vs uscita); verifica manuale:
cambio cartella → nuova chat → primo messaggio produce spine `session.started`
nella cartella giusta e nessuna dir fantasma in `.zelari/sessions/` del nuovo
progetto.

**Commit:** `fix(desktop): switching folder starts a new chat instead of rebinding the session spine`

---

## FIX-4 (P1) — Steering: noop `already_finished` non deve perdere il testo

**Problema.** Se il run termina nella finestra tra il check `running` nel
composer e la consegna, `session.steer` risponde col noop esplicito
`already_finished` (§24): il testo viene **scartato** e la bolla steered resta
bloccata a "sent" per sempre (nessun ack aggiorna lo stato).

**Evidenza.**
- `apps/desktop/src-tauri/src/harness_sidecar.rs:876-911` — `steer_run` fa
  roundtrip `session.steer`; `Ok(_) => Ok(())` **scarta il payload del noop**.
- `src/cli/serve/harnessServer.ts` (session.steer, ramo no live turn) — noop
  tipizzato, mai finto successo.
- `apps/desktop/src/App.tsx:2102-2160` — la bolla aggiorna lo stato solo sugli
  ack-event; il noop non produce eventi.

**Soluzione.**
1. `steer_run` ritorna il `result` del roundtrip (non solo `Ok(())`); il
   comando `send_control` propaga il payload al frontend.
2. Frontend: su `already_finished` → bolla → stato `not_applied` (visibile),
   **prefill del composer** col testo (stesso trattamento di
   `follow_up_queued`) + status line esplicito.
3. Opzionale (stesso commit): chiudere anche il caso inverso — risposta
   `unknown_method` già gestita con errore visibile, verificarla nei test.

**Test.** Unit sul plumbing del payload; manuale: steer a fine run → composer
prefillato, bolla non appesa.

**Commit:** `fix(desktop): surface already_finished steer noop as composer prefill, never drop the text`

---

## FIX-5 (P1) — Doctor: validare davvero `engines.node`

**Problema.** `checkNode` ignora il `pkg.engines` che riceve e usa una soglia
hardcoded `major < 20` con messaggio fuorviante "(>= 20.0.0)". Node 20.20.1
passa come OK benché il requisito sia `>= 24.0.0` — ha mascherato l'intera
famiglia di problemi sulle macchine pulite.

**Evidenza.** `src/cli/utils/doctor.ts:208-232`.

**Soluzione.** Parsare `pkg.engines.node` (formati `>=24.0.0`, `^24`, `24.x`):
sotto il major richiesto → **FAIL critico** con messaggio corretto e remediation
("installa Node 24 LTS"); engines assente/illisible → fallback alla soglia
attuale. `npm i -g` non blocca su engines (solo warning EBADENGINE): il doctor
è l'ultimo posto onesto dove dirlo.

**Test.** Unit `checkNode` con pkg fake: engines >=24 con node 20 → FAIL;
node 24 → OK; engines assente → comportamento fallback.

**Commit:** `fix(cli): doctor validates node against package engines requirement`

---

## FIX-6 (P1) — Desktop: listener per `harness-sidecar-status` e `harness-sidecar-log`

**Problema.** Il backend emette entrambi gli eventi (status del ciclo di vita,
stderr del sidecar — drenato anche su file in `<app_data_dir>/logs/zelari-sidecar.log`)
ma il frontend **non ha alcun listener**: ogni errore di boot/spawn/crash è
 invisibile. È la ragione per cui "il modello non risponde mai" appare come
 silenzio invece che come "Node.js not found on PATH" / "did not send the
 protocol_info boot line".

**Evidenza.**
- `apps/desktop/src-tauri/src/harness_sidecar.rs:289-297` (emit_status, "the
  frontend has no listener yet"), `:445-500` (stderr drain → evento + file).
- Verifica frontend: nessun `listen('harness-sidecar-status' | 'harness-sidecar-log')`
  in `apps/desktop/src`.

**Soluzione.**
1. Listener in `agentClient.ts`: `harness-sidecar-status` → banner di stato
   (ready / failed / down dopo restart exhaustion) con l'ultimo messaggio.
2. `harness-sidecar-log` → pannello diagnostico collassabile con ring-buffer
   (cap ~200 righe), raggiungibile dalla chat; errori/stack in evidenza.
3. Stato "down" persistente nel tempo (dopo MAX_RESTART_ATTEMPTS) deve restare
   visibile finché il next run non riporta esito.

**Test.** Manuale: avviare il Desktop senza node nel PATH del processo GUI →
banner visibile con l'errore esatto. Unit sul buffer/normalizzazione eventi.

**Commit:** `feat(desktop): surface harness sidecar status and stderr log in the UI`

---

## FIX-7 (P2, minore) — Follow-up in coda: non perderli alla chiusura

**Problema.** I follow-up (steer tardivi convertiti, `follow_up_queued:`)
sopravvivono solo come bolla di sistema + prefill del composer: chiusura app o
nuovo draft = testo perso. La coda in-memory muore col run by design (§28).

**Evidenza.** `src/cli/headless/runOneTurn.ts:876-878`, `App.tsx:1131-1150`.

**Soluzione.** Persistere i follow-up pendenti nella conversazione
(`chatStorage`, campo `pendingFollowUps`) e ripristinarli come prefill al
prossimo avvio finché non inviati/scartati dall'utente.

**Commit:** `feat(desktop): persist queued follow-ups across app restarts`

---

## FIX-8 (P1) — Watchdog turno: idle-based, non wall-based + coerenza soglie

**Problema.** Il watchdog del turno Desktop (`TURN_TIMEOUT_DEFAULT_SECS = 1800`)
scatta su tempo di muro e **ignora l'attività**: stacca turni che stanno
lavorando regolarmente. Riprodotto il 2026-09-01 alle 18:49: turno iniziato
18:19:52, completato 18:49:52 (**esattamente 1800s**) — il watchdog ha fatto
detach + `session.cancel` cooperativo proprio mentre l'agente concludeva
(ultimo assistant.message 18:49:51, `session.ended` pulito). L'esito del lavoro
è stato scartato dalla UI con l'errore `turn_timeout: run.turn did not settle
within 1800s — the model call may be hanging (network egress?)` — messaggio
fuorviante: nessun hang di rete.

**Composizione del turno da 30' (dalla spine, sessione 921987c9):**
- **1203s (20') in un singolo gap**: tentacolo Kraken `task` — i turni interni
  sono off-spine (ADR-0024) → 20 minuti di invisibilità totale, poi
  `memory_write` + 4 `tool.result` consegnati in blocco + rapporto finale.
- ~7' di latenze modello (5 gap assistant→tool da 60-110s, provider GLM).
- 38 tool call di cui 4 `npx vitest run` completi.

**Incoerenza strutturale:** il timeout turno del Desktop (30') è **minore**
del timeout massimo di un tentacolo (`TASK_TOOL_TIMEOUT_MS = 45'`): per
costruzione il Desktop può staccare un turno che il CLI porterebbe a termine.
Inoltre, al detach la risposta `run.turn` finale finisce in un pending che
nessuno legge → il lavoro completato viene perso dalla UI anche quando arriva
a fine naturale.

**Soluzione.**
1. **Idle-deadline invece di wall-deadline** in `long_turn`
   (`harness_sidecar.rs`): il timer si resetta a ogni evento ricevuto per il
   run (message_delta, tool_execution_start/end, resource snapshot, note).
   Soglia idle consigliata: 300-600s (un model call appeso muore comunque; un
   lavoro vivo non viene mai ammazzato dall'orologio).
2. Coerenza soglie: `ZELARI_SIDECAR_TURN_TIMEOUT_SECS` (se resta come cap
   wall) ≥ `TASK_TOOL_TIMEOUT_MS`; oppure cap wall rimosso del tutto a favore
   del solo idle + budget CLI (40 tool call / wall per epoch).
3. Al fire del watchdog con cancel cooperativo riuscito: il detach non deve
   buttare un risultato che arriva pochi secondi dopo — trattenere il pending
   per una finestra di grazia (es. 60s) prima di abbandonarlo.

**Test.** Unit su idle-reset (eventi che estendono il deadline); manuale:
turno lungo con tentacolo > 30' → completa senza turn_timeout; run con model
call appesa → idle-timeout scatta entro la soglia.

**Commit:** `fix(desktop): idle-based turn watchdog replaces wall clock timeout`

---

# 3. Ordine di esecuzione e priorità

| # | Fix | Area | Priorità | Rischio |
|---|-----|------|----------|---------|
| 1 | FIX-1 anti-self-kill | CLI/safety | P0 | basso (solo denial + test) |
| 2 | FIX-2 lock spine (3 commit) | core+CLI | P0 | medio (tocca il writer — test esaustivi) |
| 3 | FIX-3 pickFolder nuova chat | Desktop | P0 | basso |
| 4 | FIX-5 doctor engines | CLI | P1 | basso |
| 5 | FIX-8 watchdog idle-based | Desktop/Tauri | P1 | medio (timistica long_turn) |
| 6 | FIX-4 steer noop prefill | Desktop+Tauri | P1 | medio (plumbing Rust→FE) |
| 7 | FIX-6 listener sidecar | Desktop | P1 | basso |
| 8 | FIX-7 follow-up persistenti | Desktop | P2 | basso |

Sequenziati così: prima si fermano le emorragie (self-kill e lock: causano il
"non risponde mai"), poi la correttezza semantica (cartella/sessione, doctor),
poi osservabilità, infine il minore.

---

# 4. Verifica finale (per ogni commit + a fine piano)

```
npm run typecheck
npm run test          # incluse le nuove suite: selfKillGuard, writer takeover,
                      # sweep, checkNode, pickFolder, steer noop
npm run smoke
```

Manuale sul Desktop (dev): `npm run desktop:dev` —
1. turno lungo con preview server + richiesta di "ferma il server" → il guard
   rifiuta il taskkill globale e propone il kill per porta; il sidecar sopravvive.
2. kill -9 del sidecar a metà turno → resume immediato della stessa sessione →
   spine attiva (no `locked`), warning visibile se degradata.
3. cambio cartella su chat usata → nuova chat, spine del progetto giusto.
4. steer sparato a run appena finito → bolla `not_applied` + composer prefillato.
5. Desktop senza node raggiungibile dal processo GUI → banner errore visibile.
6. `zelari-code --doctor` con Node 20 → FAIL critico engines.

---

# 5. Fuori scope (annotato, non in questo piano)

- Riuso PID su Windows: mitigato dall'heartbeat, non eliminabile senza boot-id
  (eventuale `process.boottime` come hardening futuro).
- Renderizzazione dedicata dell'attività tentacoli in Desktop (gli eventi
  NDJSON già ci sono via `onTentacleEvent`): eventuale card attività —
  mitigerebbe anche l'opacità dei 20' off-spine vista nel caso FIX-8.
- Comunicazione requisito Node 24 in README/GUIDA + warning a installazione.
