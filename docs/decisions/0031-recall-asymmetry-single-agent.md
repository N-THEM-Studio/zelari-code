# ADR-0031 — Asimmetria recall su path single-agent (W3)

**Status:** Accettato
**Date:** 2026-08-30
**Promoted from:** `.zelari/decisions/014-adr-asimmetria-recall-single-agent.md` (2026-08-30) · Task: t43
**Precedente:** ADR-0016/0021 (spine), W2 (telemetria context.projection)

## Context

MemoryV2 today è **write-only sui path single-agent** (kraken TUI chat, `runOneTurn`):
- a fine turno si chiama `remember` (i fatti finiscono nel backend SQLite);
- ma nessun host passa `memoryService` all'`AgentHarness` (`config.memoryService?`, `AgentHarness.ts` L287-295) → `prepareMemoryContext()` (L1233) no-op → **zero iniezione** di contesto durable;
- il recall avviene solo dove l'host chiama esplicitamente `buildContext` (council prompt `memoryHits`) o dove MemoryV2 è pinnata (sidecar desktop);
- lo scoring (`packages/core/src/memory/scoring.ts`) non vede segnali di budget/costo.

Prima di costruirci sopra (HarnessState, learned policy) serve decidere se l'asimmetria è un bug o una scelta.

## Decision

**L'asimmetria è deliberata in questa fase e diventa opt-in misurabile, non default silenzioso.**

1. Single-agent resta **senza recall iniettato** di default: i turni singoli restano lean, la memoria accumula valore cross-sessione e per i path council/graph che già consumano.
2. Il caso "recall ovunque" non si abilita alla cieca: si valuta dopo W2 usando il segnale `context.projection` sulla spine (`contextChars`, `returnedCount`, `durationMs` per turno). Gate per abilitare il recall su un path: **correttezza ≥ baseline** (eval `tools/eval`) **e** costo token/latenza dentro il budget dichiarato del path.
3. Quando si abilita, il canale è quello già esistente: `AgentHarness.config.memoryService` + `memoryQuery` (NIENTE secondo percorso di iniezione).

## Consequences

- Nessun code change immediato richiesto da questa ADR (la decisione è "status quo documentato + gate misurabile").
- W2 rende il gate valutabile: senza `context.projection` la condizione del punto 2 non era verificabile.
- Lo scoring senza segnali di costo resta un limite accettato; se la learned policy (futura) dovrà pesare costo, andrà esteso `MemoryEvent` (sempre identifiers/counters, mai contenuto).

## Alternatives considered

- **Recall default ON ovunque**: rifiutato — cambia il contesto di ogni turno single-agent senza baseline di confronto; rischio regressione silenziosa.
- **Rimuovere remember dai path senza recall**: rifiutato — perde il valore cross-sessione che i path council/graph già usano.
