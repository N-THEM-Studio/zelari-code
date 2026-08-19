# ADR-0016 — Log di sessione event-sourced come unica fonte di verità

**Status:** Accepted
**Date:** 2026-08-19 (ratificato; proposto 2026-08-18)

## Contesto

Oggi lo "stato di una sessione" è ricostruito da **più scrittori/lettori paralleli**, ognuno con la propria
semantica, che possono divergere tra loro:

- `sessionManager.ts` — sidecar JSONL + marker `current.txt` della sessione corrente.
- `state/fileStateStore.ts` — stato durevole (plan/rischi/ADR) separato dal log eventi.
- `checkpoint/checkpointManager.ts` — i ref git **sono** la persistenza ("no separate metadata file to drift").
- `traceStore.ts` — tracce strutturate per la vista fan-out/trace.
- `hooks/eventsToMessages.ts` — ricostruzione eventi → messaggi per transcript e compaction.
- `compaction.ts` + `budget/llmCompact.ts` — compattazione della cronologia.
- `state/restoreState.ts` / `state/loadDurableContext.ts` — resume/ripristino.

Il sintomo più noto è il bug di *split-brain* documentato in `sessionKindRouter` (v0.4.2): il router scriveva
`idA` su disco mentre l'hook scriveva `idB` in memoria/writer. Conseguenza di fondo: fork, resume, transcript,
telemetria e compaction **non sono garantiti concordare**, perché ognuno ri-deriva lo stato a modo proprio.

*Origine dell'idea:* l'invariante "model-visible ⟺ logged" e l'append-only log come unica fonte di verità
ispirati a deepseek-harness (Cordis), adattati senza vendoring del framework.

## Decisione

Adottare un **unico stream JSONL append-only di `SessionEvent`** come fonte di verità di una sessione, con
l'invariante centrale:

> **"model-visible ⟺ logged"** — tutto ciò che raggiunge il modello (frammenti di system prompt, messaggi
> utente, delta assistant, tool call, tool result, confini di compaction, usage/token) è ricostruibile dal log,
> verificato da un assert nel punto di assemblaggio messaggi (attivo solo in dev/CI, mai in produzione).

Regole operative:

1. **Un solo writer** (`appendEvent()`) e **un solo reader** (`replaySession()`); nessun altro modulo mantiene
   stato parallelo della conversazione.
2. I **consumer derivano viste materializzate** (array messaggi, budget token, transcript, telemetria, costi)
   tramite replay del log, con un cursore incrementale opzionale per evitare il replay completo a ogni turno.
3. I **checkpoint git** restano, ma come *puntatori nominati* dentro la timeline del log (il log è la base
   durevole; i ref git sono indici, non duplicati).
4. Il formato è **versionato** con un `SCHEMA_VERSION` monotonic crescente (si aggancia a `MIGRATION.md`),
   così le migrazioni diventano meccaniche invece che "a memoria".

## Alternative considerate

1. **Mantenere gli store paralleli + riconciliazione periodica** — rifiutata: la deriva tra store è la causa
   radice; riconciliare a posteriori non la elimina.
2. **Port integrale di Cordis** (event-emitter a effetti reversibili, ~100 package) — rifiutata: salto enorme,
   modello a ciclo di vita diverso e viola la convenzione "zero nuove dipendenze pesanti". Si adotta l'*idea*,
   non il framework.
3. **SQLite al posto di JSONL** — rimandata: JSONL è append-only friendly, grep-abile e già la forma su disco;
   SQLite può essere un'ottimizzazione successiva se l'accesso random diventa collo di bottiglia.

## Conseguenze

**Positive**

- Un solo invariante da testare (`model-visible ⟺ logged`) invece di N meccanismi.
- Fork, resume, transcript, compaction e telemetria concordano per costruzione.
- Il refactor è il ROI più alto: è la base su cui già poggiano compaction, checkpoint, transcript e costi.

**Negative / residuali**

- Migrazione dagli store sparsi esistenti (work incrementale, non big-bang).
- Costo di replay per sessioni lunghe — mitigato da snapshot di compaction + cursore.
- L'assert farà emergere deriva latente preesistente (bene, ma richiede pulizia prima di abilitarlo).

## Ratifica (2026-08-19) — decisioni integrate

1. **Location (era TODO aperto):** le sessioni vivono a livello progetto in
   `<workspaceRoot>/.zelari/sessions/<sessionId>/events.jsonl`, con override via env
   `ZELARI_SESSIONS_DIR` (test/CI/Desktop multi-cwd). Il percorso legacy
   `~/.tmp/zelari-code/sessions/` (sidecar `sessionJsonl.ts`) resta leggibile ma
   è read-only compat: nessuna nuova scrittura sul sidecar da parte della spine.
2. **Single writer con ownership lock:** `<sessionDir>/writer.lock` creato con
   `flag:'wx'` contiene `{ownership, pid, ts}`; un secondo writer riceve
   `SessionLogLockedError`. Takeover consentito solo su lock stantio
   (`staleLockMs`, default 10 minuti).
3. **`seq` monotona senza buchi:** parte da 1, incrementata dal writer dopo la
   validazione Zod dell'envelope; il replay riporta `corrupt-line`, `seq-gap`,
   `seq-duplicate`, `seq-nonmonotonic` come `ReplayIssue` senza mai crashare.
4. **`SCHEMA_VERSION = 1`** nell'envelope di ogni riga; migrazioni meccaniche
   documentate in `MIGRATION.md`.
5. **Surface vs state events:** `isModelSurfaceEvent` è l'unico predicato che
   decide cosa entra in `deriveMessages`; tutto il resto (task, note, mission,
   verification) è state-event derivabile ma non model-visible di default.
6. **Lineage:** `forkSession` copia gli eventi fino a `fromSeq` in una nuova
   sessione e appende `session.forked {parentSessionId, parentSeq}`;
   `resumeSession` riapre il log e appende `session.resumed`.
7. **Coesistenza con `plan.json` (ADR-0018):** il file resta store cross-session;
   la spine logga le transizioni `task.created`/`task.updated` per-sessione. Il
   file è l'indice, il log la timeline.

## TODO

- [x] Definire lo schema `SessionEvent` v1 con `SCHEMA_VERSION`.
- [x] Introdurre il writer singolo `appendEvent()` e il reader `replaySession()` (`packages/core/src/session/`).
- [ ] Cablare l'assert "model-visible ⟺ logged" nell'assemblaggio messaggi (solo dev/CI).
- [ ] Migrare i consumer: `eventsToMessages`, `compaction`, `traceStore`, telemetria, `restoreState`.
- [ ] Trattare i checkpoint git come puntatori nominati nella timeline del log.
