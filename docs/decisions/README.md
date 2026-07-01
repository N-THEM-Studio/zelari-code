# Architecture Decision Records (ADRs)

Questa directory contiene le decisioni architetturali di Zelari Code.
Ogni decisione è immutabile una volta accettata; i cambiamenti avvengono
scrivendo un **nuovo** ADR che segnala il precedente come
"Sostituito da".

## Indice

| #    | Titolo                                              | Stato       | Data       |
|------|-----------------------------------------------------|-------------|------------|
| 0001 | Monorepo con npm workspaces per `@zelari/core`       | ✅ Accettato | 2026-07-01 |
| 0002 | Pubblicazione di `@zelari/core` su npm               | Proposto    | 2026-07-02 |
| 0003 | Schema di versionamento per monorepo zelari-code     | Proposto    | 2026-07-02 |
| 0004 | Policy di stabilità API pubblica di `@zelari/core`   | Proposto    | 2026-07-02 |
| 0005 | Deprecation dei path sorgente legacy                | Proposto    | 2026-07-02 |

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
2. Andrea approva/rigetta/rename.
3. Se accettata: si implementa nei commit successivi, linkando
   l'ADR nel commit message (`Refs ADR-000X`).
4. ADR chiuse hanno tutti i TODO spuntati.
