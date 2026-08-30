# ADR-0024 — Chiusura del dual-write: la spine come unica sorgente del contesto modello

**Status:** Accettato (emendato 2026-08-30; v1.1 2026-08-30)
**Date:** 2026-08-19

## Contesto

L'ADR-0016 ha definito il contratto della session spine (log JSONL append-only,
invariante "model-visible ⟺ logged"), ma durante l'alpha il wiring è rimasto
**dual-write**: lo store 1.x in-process (`hooks/conversationContext.ts`) e il
sidecar JSONL BrainEvent erano il "transcript of record", mentre la spine era
un mirror best-effort (`SessionSpineMirror`, `sessionSpine.ts`). Il contesto
del modello veniva costruito dallo store/`--history` legacy, non dalla spine.

Con le slice E1.1–E1.4 (2.0.0-alpha.5) i flussi sono stati invertiti:

- **E1.1** — adapter unico `derivedToAgentMessages()` in `@zelari/core/session`
  (`DerivedMessage[] → AgentMessage[]`), con perdite documentate.
- **E1.2** — headless (kraken/council/zelari): `--history` diventa import
  one-shot nella spine (`seedHeadlessModelHistory`); resume deriva dal log.
- **E1.3** — TUI: `dispatchPrompt` deriva il seed dalla spine prima di loggare
  il prompt; lo store resta fallback dichiarato.
- **E1.4** — Desktop: resume via evento `session_started` + `--resume <id>`;
  la snapshot 1.x resta fallback di import.
- **E1.6/E1.7** — replay deterministico dal solo `events.jsonl` e invariante
  model-visible⟺logged come gate CI (`npm run test:session`).

Residuo al momento di questa ADR: la **budget pipeline** (singolo e council)
misurava ancora `getHistory()` (store 1.x) invece del seed spine-derived, e il
path council compattava lo store senza emettere `session_compacted` sulla
spine (drift del confine di compaction).

## Decisione

1. **La spine è l'unica sorgente del contesto modello** su ogni path caldo
   (headless kraken/council/zelari, TUI singolo/council). Ogni seed harness
   passa per `deriveMessages()` → `derivedToAgentMessages()` /
   `derivedModelSeed()`. Nessun nuovo builder di history: chi ha bisogno di
   contesto deriva dalla spine.
2. **Lo store 1.x e il sidecar BrainEvent sono superficie mirror** (render UI,
   export, migrazione), non source of truth. `sessionManager.ts` è deprecato
   per il model context: persistenza UI (`/sessions`, `/resume`, marker) e
   sorgente read-only per migrazione.
3. **La budget pipeline misura il seed spine-derived** (`historyForModel` /
   `councilHistory`), non lo store. Se la pipeline compatta, il replay
   sostituisce il seed del turno corrente e l'evento `session_compacted`
   viene emesso su **entrambi** i path (singolo e council), così la derive
   successiva vede il confine di compaction.
4. **Fallback discreto dichiarato**: spine degradata/disabled → seed dallo
   store 1.x (comportamento pre-spine), testato. Un errore della spine non
   rompe mai il turno.
5. **`ZELARI_SESSION_SPINE=0` è kill switch di emergenza/debug**, non un
   default di release.
6. **Rimozione del dual-write a 2.0.0-rc**: quando replay/invariante saranno
   stabili per un ciclo completo (C1–C3 chiusi), lo store 1.x smette di
   alimentare il fallback e diventa pura vista UI/export; la rimozione
   definitiva sarà oggetto di ADR separata.

## Alternative

- **Mantenere il dual-write a tempo indeterminato** — scartato: due cervelli
  divergono (bug split-brain v0.4.2), la compaction non era visibile al
  modello derivato, e ogni feature (resume, fork, export, verification)
  doveva essere implementata due volte.
- **Big-bang single-write senza fallback** — scartato: un fallimento I/O
  della spine renderebbe il prodotto inutilizzabile; il fallback discreto è
  la politica di sicurezza del turno (P3).
- **Derivare il model context dal sidecar BrainEvent 1.x** — scartato: il log
  1.x non registra i prompt utente (buco P1) e non ha confini di compaction
  affidabili.

## Conseguenze

- **Positive**: una sola storia da ricostruire (replay verificato in CI);
  resume/fork/export funzionano dallo stesso log; la compaction è visibile al
  modello; il contratto `@zelari/core/session` è l'unica API di contesto.
- **Negative**: la derive paga un costo I/O per turno (letto incrementale
  mitigato dal projection cache); durante l'alpha esistono ancora due
  rappresentazioni da tenere allineate (mirror).
- **Neutral**: i builder `buildAgentUserWithHistory` /
  `buildCouncilTaskWithHistory` restano formattatori di prompt — ricevono
  solo input spine-derived e sono coperti dai test di replay.

## TODO

- [x] E1.5 — budget pipeline su seed spine-derived + `session_compacted` su path council
- [x] Test architetturale `legacyContextIsolation.test.ts` (nessuna ricaduta nello store per il model context)
- [ ] A 2.0.0-rc: valutare rimozione fallback store → ADR successiva

## Amendment (2026-08-30) — host graph sulla spine (W1, release 2.17)

Con la 2.17 l'elenco dei **path caldi** del punto 1 della Decisione si estende
all'**host graph**: `runHeadlessKrakenGraph` (`src/cli/runHeadless.ts`) apre il
log di sessione (`openHeadlessSpine`, mode `kraken`, workspace risolto), gated
`session.started` su `--output json`, e lo chiude su ogni uscita
(completed/error/cancelled, incluso il SIGINT gestito); un fallimento della
spine non cambia mai l'exit code. Il graph host non bypassa più questa ADR sui
run default-on.

**Special-case dichiarato — copertura spine v1 sui run graph: ENVELOPE-ONLY.**
Sui run graph il log spine contiene gli eventi di envelope del run
(`started` / `user.message` / `ended`) più lo scaffolding host session-level
node-independent (`session.harness_manifest`, `note`, `resource.*`,
`task.contract`, scritti dal mirror a ogni apertura/turn-prep, identici con
grafo vuoto o popolato); gli eventi **per-nodo** e i **turn interni** dei
tentacoli NON finiscono sul log spine in v1 (i tentacoli scrivono sul canale
kraken radio JSONL, non sulla spine). Il contratto è pinnato da un test
differenziale in `src/cli/krakenGraphSpine.test.ts` (run con grafo vuoto vs
grafo 1-nodo: sequenza spine identica). È un contratto special-case dichiarato
qui, non una copertura completa: l'approfondimento (per-node events sulla
spine) è rinviato.

- [ ] Approfondire la copertura per-node dei run graph sulla spine (post-v1)

## Amendment v1.1 (2026-08-30) — envelope per-nodo sui run graph

**Sostituisce lo special-case envelope-only** dell'emendamento del 2026-08-30
(la voce TODO "Approfondire la copertura per-node" qui sopra è chiusa da
questo emendamento). Sui run graph la spine ora porta anche l'**envelope
per-nodo**: eventi di stato `graph.node_started` / `graph.node_ended`
(aggiunti al vocabolario chiuso di `packages/core/src/session/types.ts` con
schema review per ADR-0021 — tipi additivi state-only, **senza bump di
SCHEMA_VERSION**, che resta 1: il replay tollerante dei lettori più vecchi li
segnala come `schema-mismatch` e li salta, e `deriveMessages()` non cambia —
non sono model-surface).

**Chi scrive — solo l'HOST.** L'emissione vive in `runHeadlessKrakenGraph`
(`src/cli/runHeadless.ts`): l'host avvolge il seam di run del tentacolo
(`runTentacleFn`, helper `nodeSpineEnvelopeRun`) — lo stesso invocato
dall'executor per ogni turno di nodo — e appende la coppia started/ended via
`spine.appendEvent` con `actor: system`. I tentacoli/subagent NON scrivono mai
sulla spine (né lo stub di test, né il codice reale): il single-writer
dell'ADR-0024 non cambia.

**Cosa va sulla spine — solo envelope/metadata.** Payload dichiarato:
`nodeId`, `agent`, `graphId?` su started; `nodeId`, `agent`, `graphId?`,
`ok`, `cancelled?` (solo su run cancellato) e `durationMs` misurato
dall'host su ended. Una coppia per **tentativo** (retry/rework = nuova
coppia); i nodi `merge` non guidano tentacle e restano radio-only.
Nessun contenuto modello: label del nodo, prompt, testo assistant, output di
tool NON finiscono sulla spine — restano sul canale kraken radio JSONL
(`node_start`/`node_end` con `detail`), correlate dallo stesso `sessionId`.

**Contratto pinnato** dal test differenziale aggiornato in
`src/cli/krakenGraphSpine.test.ts` (run grafo vuoto vs grafo 1-nodo con turno
reale: il run 1-nodo aggiunge ESATTAMENTE la coppia `graph.node_started`/
`graph.node_ended` alla sequenza del grafo vuoto — rimossa la coppia, le
sequenze coincidono kind-per-kind; assenti `tool.call`/`tool.result`/
`assistant.message`/`verification.*`; nessun payload della spine contiene
contenuto del turno).
