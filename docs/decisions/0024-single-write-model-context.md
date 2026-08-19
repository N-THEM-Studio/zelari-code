# ADR-0024 — Chiusura del dual-write: la spine come unica sorgente del contesto modello

**Status:** Accettato
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
