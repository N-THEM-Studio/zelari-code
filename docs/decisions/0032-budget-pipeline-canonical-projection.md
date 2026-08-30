# ADR-0032 — Unificazione proiezione: la budget pipeline CLI è il compilatore canonico (W4)

**Status:** Accettato
**Date:** 2026-08-30
**Promoted from:** `.zelari/decisions/015-adr-unificazione-proiezione-budget-pipeline-canonical.md` (2026-08-30) · Task: t44
**Precedenti:** ADR-0016/0021 (spine), W1 (graph su spine), W2 (context.projection)

## Context

Oggi esistono **due sistemi di proiezione del contesto, paralleli e divergenti**:

1. **Budget pipeline CLI** (`src/cli/budget/`: tokenBudget + llmCompact + persistCompact, orchestrata da `buildModelContext` in `src/cli/budget/modelContextBuilder.ts`): spine-aware, emette `session.compacted` con fingerprint/strategia/token salvati, è quella che alimenta il loop principale (TUI, headless, council).
2. **`ContextProjector` core** (`packages/core/src/context/ContextProjector.ts`): non conosce la spine; l'unico consumatore di produzione è il parent-context dei tentacoli (`taskTool.ts`).

Costruire HarnessState (read-model tipizzato sopra la spine) sopra due sistemi obbligava a scegliere o a crearne un terzo.

## Decision

**La budget pipeline CLI è il compilatore canonico del contesto di turno. Nessun terzo sistema.**

1. `ContextProjector` non si estende: il suo scope si dichiara esplicitamente come **parent-context dei tentacoli** (l'unico consumatore reale) e va documentato come tale nel file; non diventa mai la sorgente del contesto del loop principale.
2. HarnessState **non compila contesto**: è un read-model che legge ciò che è già stato deciso e loggato — eventi `session.compacted` + note `context.projection` (W2) + envelope di turno. Osserva, non proietta.
3. Se in futuro ContextProjector servisse nel loop principale, la strada è **assorbirlo nella budget pipeline** (diventandone una strategia), non il contrario.

## Consequences

- Il cammino per HarnessState è libero da ambiguità: consuma la spine, non ha dipendenze dalla pipeline né dal proiettore.
- La docstring/scope declaration su `ContextProjector.ts` è l'unico code touch richiesto (commento, no behavior); la declassificazione completa (deprecazione) è rinviata a 2.x — il tentacle parent-context resta un consumatore legittimo.
- Ogni nuova metrica di proiezione va sulla spine (pattern W2), mai su un canale laterale.

## Alternatives considered

- **ContextProjector come compilatore unico**: rifiutato — non spine-aware, privo della telemetria di compaction già collaudata; migrare il loop principale sarebbe un rewrite ad alto rischio per zero guadagno.
- **Terzo sistema "unificato" ex novo**: rifiutato — massimo rischio, duplicazione, e HarnessState diventerebbe la quarta proiezione.
