# ADR-0021 — Contratto Session spine v1

**Status:** Accepted
**Date:** 2026-08-19

## Contesto

ADR-0016 definisce *cosa* vuole (un unico log append-only come fonte di verità) ma non
il contratto operativo. La migrazione CLI (render da eventi, resume/fork UX) richiede
un formato stabile prima di toccare gli host.

## Decisione

Il modulo `@zelari/core/session` implementa la spine v1 con questo contratto pubblico:

- **Envelope** (`SessionEventEnvelope`): `{schemaVersion: 1, sessionId, seq, ts, kind, actor, data}` —
  una riga JSON per evento; `kind` appartiene a `SESSION_EVENT_KINDS` (vocabolario chiuso,
  estendibile solo con minor schema o nuova schemaVersion).
- **Writer** (`SessionLogWriter`): single-writer con lock `wx` + takeover su stantio;
  `seq` assegnata dopo validazione Zod; append concatenato (ordine su disco garantito).
- **Replay** (`readSessionLog`): tollerante — righe corrotte saltate e riportate come
  `ReplayIssue` (`corrupt-line`, `seq-gap`, `seq-duplicate`, `seq-nonmonotonic`,
  `schema-mismatch`); mai eccezione su log parziale.
- **Proiezione** (`buildProjection`): viste derivate (messaggi, conteggi tool,
  verification summary, lineage fork) — nessuno stato parallelo persistito.
- **Path modello unico** (`deriveMessages` + `isModelSurfaceEvent`): solo i kinds della
  surface entrano nella history; invariant P1 "model-visible ⟺ logged" verificabile
  staticamente sul vocabolario.
- **Lineage**: `forkSession` (copia ≤ fromSeq + evento `session.forked`),
  `resumeSession` (riapre + `session.resumed`), `lineageOf` (catena ancestor).
- **Export**: formato `zelari-session-export/1` (macchina-leggibile, senza lock).

## Alternative considerate

1. **Estendere il sidecar `sessionJsonl.ts`** — rifiutata: manca seq/lock/versione e la
   sua forma è legata a `BrainEvent` (stream live con `message_delta`, non timeline).
2. **SQLite** — rimandata (come in ADR-0016): JSONL resta grep-abile e append-only.

## Conseguenze

**Positive** — resume/fork/export deterministici sul piano della trajectory; falsi
"done" ricostruibili; base per profili confrontabili (stesso task → stesso schema eventi).

**Negative** — vocabolario chiuso richiede disciplina nei contributi; replay di sessioni
molto lunghe andrà mitigato con cursore/snapshot (fase successiva, non bloccante).

Riferimenti: `packages/core/src/session/`, `docs/plans/gap-map-model-visible.md`.
