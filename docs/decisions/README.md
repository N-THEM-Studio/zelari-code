# Architecture Decision Records (ADRs)

Questa directory contiene le decisioni architetturali di Zelari Code.
Ogni decisione è immutabile una volta accettata; i cambiamenti avvengono
scrivendo un **nuovo** ADR che segnala il precedente come
"Sostituito da".

## Indice

| #    | Titolo                                              | Stato        | Data proposta | Data accettazione |
|------|-----------------------------------------------------|--------------|---------------|-------------------|
| 0001 | Monorepo con npm workspaces per `@zelari/core`       | ✅ Accettato | 2026-07-01    | 2026-07-01 (retro su commit `6ec90be`) |
| 0002 | Pubblicazione di `@zelari/core` su npm (MIT)         | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |
| 0003 | Schema di versionamento per monorepo zelari-code     | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |
| 0004 | Policy di stabilità API pubblica di `@zelari/core`   | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |
| 0005 | Deprecation dei path sorgente legacy                | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |

## Formato

- **Filename:** `NNNN-titolo-kebab-case.md` (4 cifre, zero-padded).
- **Status values:**
  - `Proposto` — scritto, in attesa di OK Andrea.
  - `Accettato` — implementato o in implementazione.
  - `Sostituito` — superseded da un ADR successivo (link lì).
  - `Ritirato` — accettato poi revocato (raro).
- **Struttura:** Contesto → Decisione → Alternative →
  Conseguenze → TODO.
- **Lingua:** italiano (coerente con il resto di zelari-code).

## Processo

1. MiniMax (o contributor) propone un'ADR quando vede una decisione
   non ovvia che vincola il codice futuro.
2. **Default:** ADR scritti da MiniMax sono **auto-accettati alla
   creazione**, salvo obiezione esplicita di Andrea. Questo perché
   le proposte partono già da un'analisi di coerenza col codice
   esistente. Se Andrea dissente, l'ADR viene:
   - Rivisto (cambio di decisione, append "Rescindito").
   - Sostituito da un nuovo ADR che marca il vecchio come
     `Sostituito`.
3. ADR accettati hanno tutti i TODO spuntati o spostati in issue
   tracker.
