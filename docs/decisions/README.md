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
| 0006 | Lucifero chairman synthesis reale (v0.6.0)           | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |
| 0007 | Independent pre-release audit (agy) come workflow gate | ✅ Accettato | 2026-07-02    | 2026-07-02 (auto, MiniMax-M3) |
| 0008 | Monorepo MIT per rilascio open source (Anathema Studio) | ⚠️ Sostituito | 2026-07-15    | 2026-07-15 (→ ADR-0009) |
| 0009 | Licenza Apache-2.0 per l'intero monorepo | ✅ Accettato | 2026-08-13    | 2026-08-13 |
| 0010 | Manifesto dei principi primi (PRINCIPLES.md, P1–P6) | ✅ Accettato | 2026-08-13    | 2026-08-13 |
| 0016 | Log di sessione event-sourced come unica fonte di verità | 📝 Proposto | da confermare | — |
| 0017 | Selezione unificata del "thinking effort" per tutti i provider | 📝 Proposto | da confermare | — |
| 0018 | Contratto workspace task store su `.zelari/plan.json` (tool `task_*`) | ✅ Accettato | slice 3a implementata (v1.43.0) | — |
| 0024 | Chiusura del dual-write: spine come unica sorgente del contesto modello | ✅ Accettato (emendato 2026-08-30) | 2026-08-19 | 2026-08-19 |
| 0025 | Default strict done divisi per superficie (Kraken opt-in, mission ON) | ✅ Accettato | 2026-08-20 | 2026-08-20 |
| 0026 | Default RC: evidence event-backed ON, Kraken strict resta opt-in | ✅ Accettato | 2026-08-20 | 2026-08-20 |
| 0027 | Strict Kraken default 2.1: resta opt-in CLI, host decide via pack | ✅ Accettato | 2026-08-20 | 2026-08-20 |
| 0028 | Native criteria pack adattivo: CLI esplicito, default a carico dell'host | ✅ Accettato | 2026-08-20 | 2026-08-20 |
| 0029 | Memoria cognitiva condivisa native-first, SQLite locale e MCP esterno | ✅ Accettato | 2026-08-23 | 2026-08-23 |
| 0030 | Razionalizzazione default HARNESS-10: strict-done e verify-pack ON, trust headless UNTRUSTED | ✅ Accettato | 2026-08-23 | 2026-08-23 |
| 0031 | Asimmetria recall su path single-agent (W3): deliberata, opt-in misurabile | ✅ Accettato | 2026-08-30 | 2026-08-30 (promossa da `.zelari/decisions/014`) |
| 0032 | Unificazione proiezione: la budget pipeline CLI è il compilatore canonico (W4) | ✅ Accettato | 2026-08-30 | 2026-08-30 (promossa da `.zelari/decisions/015`) |

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
