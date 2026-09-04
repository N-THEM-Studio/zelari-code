# Architecture Decision Records (ADRs)

Questa directory contiene le decisioni architetturali di Zelari Code.
Ogni decisione è immutabile una volta accettata; i cambiamenti avvengono
scrivendo un **nuovo** ADR che segnala il precedente come
"Sostituito da".

**Regole di numerazione** (applicate dalla triage 2026-09-04):

- Un numero a 4 cifre, una volta assegnato, **non si riutilizza mai**.
- I numeri mancanti nella sequenza (0011, 0012) **non sono mai stati
  assegnati**: non vanno riempiti retroattivamente.
- Il vault draft `.zelari/decisions/` usa una **serie separata** (id a 3
  cifre); la promozione in `docs/decisions/` prende il prossimo numero
  canonico libero.

## Indice

Generato dall'albero reale dei file (triage t37/S6, 2026-09-04).

| # | Titolo | Stato | Data proposta | Note |
|------|-----------------------------------------------------|--------------|---------------|-------------------|
| 0001 | Monorepo con npm workspaces per `@zelari/core` | ✅ Accettato | 2026-07-01 | retro su commit `6ec90be` |
| 0002 | Pubblicazione di `@zelari/core` su npm | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0003 | Schema di versionamento per monorepo zelari-code | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0004 | Policy di stabilità API pubblica di `@zelari/core` | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0005 | Deprecation dei path sorgente legacy | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0006 | Lucifero chairman synthesis reale | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0007 | Independent pre-release audit (agy) come workflow gate | ✅ Accettato | 2026-07-02 | auto, MiniMax-M3 |
| 0008 | Monorepo MIT per rilascio open source | ⚠️ Sostituito | 2026-07-15 | → ADR-0009 |
| 0009 | Licenza Apache-2.0 per l'intero monorepo | ✅ Accettato | 2026-08-13 | |
| 0010 | Manifesto dei principi primi (PRINCIPLES.md, P1–P6) | ✅ Accettato | 2026-08-13 | |
| 0013 | Budget cap (token/USD) come terza stop-rule della missione Zelari | ✅ Accettato | 2026-07-20 | implementato |
| 0014 | Mission triggers event-driven | ✅ Accettato | 2026-07-20 | implementato |
| 0015 | Opt-in companion host (`zelari-code serve`) | ✅ Accettato | 2026-07-23 | |
| 0016 | Log di sessione event-sourced come unica fonte di verità | ✅ Accettato | 2026-08-14 | accettazione 2026-08-19 |
| 0017 | Selezione unificata del "thinking effort" per tutti i provider | 📝 Proposto — parcheggiato | 2026-08-14 | triage 2026-09-04: mai implementato; riaprire su evidenza costo (t31) |
| 0018 | Contratto workspace task store su `.zelari/plan.json` (tool `task_*`) | ✅ Accettato | 2026-08-16 | slice 3a implementata (v1.43.0) |
| 0019 | Observation Integrity come clausola esplicita di P1 | ✅ Accettato | 2026-08-17 | |
| 0020 | Kraken: plan-safe explore task | ✅ Accettato | 2026-08-18 | |
| 0021 | Contratto Session spine v1 | ✅ Accettato | 2026-08-19 | |
| 0022 | Execution seams (WorkspaceProvider & friends) e profili versionati | ✅ Accettato | 2026-08-19 | |
| 0023 | Verifica deterministica e CompletionPolicy (evidence contract) | ✅ Accettato | 2026-08-19 | |
| 0024 | Chiusura del dual-write: spine come unica sorgente del contesto modello | ✅ Accettato | 2026-08-19 | emendato 2026-08-30 |
| 0025 | Default strict done divisi per superficie (Kraken opt-in, mission ON) | ✅ Accettato | 2026-08-20 | |
| 0026 | Default RC: evidence event-backed ON, Kraken strict resta opt-in | ✅ Accettato | 2026-08-20 | |
| 0027 | Strict Kraken default 2.1: resta opt-in CLI, host decide via pack | ✅ Accettato | 2026-08-20 | |
| 0028 | Native criteria pack adattivo: CLI esplicito, default a carico dell'host | ✅ Accettato | 2026-08-20 | |
| 0029 | Memoria cognitiva condivisa native-first, SQLite locale e MCP esterno | ✅ Accettato | 2026-08-23 | |
| 0030 | Razionalizzazione default HARNESS-10: strict-done e verify-pack ON, trust headless UNTRUSTED | ✅ Accettato | 2026-08-23 | |
| 0031 | Asimmetria recall su path single-agent (W3): deliberata, opt-in misurabile | ✅ Accettato | 2026-08-30 | promossa da `.zelari/decisions/014` |
| 0032 | Unificazione proiezione: la budget pipeline CLI è il compilatore canonico (W4) | ✅ Accettato | 2026-08-30 | promossa da `.zelari/decisions/015` |
| 0033 | Edit ancorato: snapshot file-level, apply esatto, errore strutturato | ✅ Accettato | 2026-09-02 | implementato (slice t72–t79, release 2.24–2.26) |
| 0034 | Desktop ships the same contract (guided CLI install first, bundling deferred) | ✅ Accettato | 2026-09-02 | identity wave |
| 0035 | Council fan-out parallelo + trace view | ✅ Accettato | 2026-07-20 | Fase B deferita; **rinumerato da "0015" duplicato** (triage 2026-09-04) |

Numeri mai assegnati: **0011, 0012** (slot liberi, non riempire).

### Legacy (numerazione pre-schema, 3 cifre)

File storici anteriori allo schema a 4 cifre. **Non** fanno parte della
serie canonica: `013` legacy ≠ `ADR-0013` (mission budget cap).

| # | Titolo | Stato | Data |
|------|-----------------------------------------------------|--------------|---------------|
| 012 | Durable State Layer + Prompt Cache Efficiency | accepted | 2026-07-18 |
| 013 | Weakness-based hypothesis selection (Bennett's Razor for Kraken) | accepted | 2026-08-08 |

### Vault draft (`.zelari/decisions/`, serie separata)

ADR del vault di design, non canonici. La numerazione vault (3 cifre) è
indipendente da quella di questa directory.

| # | Titolo | Stato | Note |
|------|-----------------------------------------------------|--------------|-------------------|
| 016 | Il TaskContract compila nel harness (capability layer + criteri) | accepted | amenda ad ADR-0023; rinumerato da "0030" vault per la collisione con l'ADR canonico 0030 (triage 2026-09-04) |

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
