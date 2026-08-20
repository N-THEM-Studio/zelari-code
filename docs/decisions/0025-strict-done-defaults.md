
**Status:** Accettato
**Date:** 2026-08-20

## Contesto

ADR-0023 ha introdotto il gate strict BUILD (`PASS | REPAIR_REQUIRED | BLOCKED`,
`unknown ≠ pass`, exit 4 dedicato) con attivazione `ZELARI_STRICT_DONE=1` —
default **off** "inizialmente, default in beta". La domanda lasciata aperta era
quale default congelandare per le due superfici che chiudono lavoro:

- **Kraken** (headless `--task` / TUI / Desktop): turni interattivi o
  single-task, l'utente è presente e può reagire al verdetto.
- **Mission** (`--mode zelari`, profilo `mission/v1`): loop autonomo
  multi-iterazione senza utente al volante; un "success" non verificato viene
  consumato da host/automation senza supervisione.

Un solo default per entrambe le superfici è sbagliato in entrambe le direzioni:
strict-ON di default in Kraken rompe la compatibilità 1.x dei task semplici
violando il principio del costo baseline; strict-OFF di default nelle mission
permette il false-done esattamente dove nessuno può intercettarlo.

## Decisione

Default **divisi per superficie** (Opzione A del documento di stato alpha.6 §7):

1. **Kraken interactive/headless: strict = opt-in.** `ZELARI_STRICT_DONE=1|true`
   oppure `--strict-done` attivano il gate; default resta **off** fino alla RC
   (poi si rivaluta con la matrice di profile smoke, ADR-0023 "default in beta").
2. **Mission: strict evidence gate = default ON.** La missione chiude sotto il
   gate senza richiedere flag; disattivazione esplicita con
   `ZELARI_MISSION_STRICT=0|false` (escape hatch documentato, non incoraggiato).

Regole di composizione (già implementate da ADR-0023 e lock test F1):

- il gate mission **somma** blocker (legacy + evidence contract + pack nativo);
- il verdict deterministico non viene mai riscritto dal verifier LLM (advisory);
- gate blocked su missione "success" → exit code 4 e
  `missionPhase('verification', 'mission-strict-blocked')` nella spine, non 0.

Guardie di sicurezza:

- il pack nativo (`ZELARI_VERIFY_PACK`) resta **opt-in separato** su entrambe le
  superfici: il default mission-ON attiva il gate del contratto di selezione,
  **non** l'esecuzione automatica di typecheck/test/build;
- missione senza required check registrati → gate vacuo, comportamento invariato
  (nessun nuovo fallimento su missioni senza selezione).

## Alternative considerate

1. **Strict-ON ovunque (Opzione B "deterministic verification default")** —
   rifiutato per ora: rompe la compatibilità 1.x di Kraken prima che la matrice
   di profile smoke (Exit-3.2) dimostri che il costo baseline dei task semplici
   non regredisce. Da rivalutare alla RC.
2. **Strict-OFF ovunque fino alla beta** — rifiutato: le missioni sono il posto
   con il rischio false-done più alto e il minor presidio umano.
3. **Un solo knob globale** (`ZELARI_STRICT_DONE` per tutto) — rifiutato: la
   semantica del default è la decisione stessa; un knob unico non può esprimere
   "opt-in qui, opt-out là" e renderebbe impossibile verificare il comportamento
   mission in CI senza inquinare Kraken.

## Conseguenze

**Positive** — il false-done è bloccato per costruzione esattamente dove non
c'è supervisione; Kraken mantiene il costo baseline 1.x; i default sono
testabili come contratto (`strictDefaults.test.ts`) e reversibili
singolarmente alla RC.

**Negative** — due env var da documentare (`ZELARI_STRICT_DONE`,
`ZELARI_MISSION_STRICT`); una missione con verifica rossa ora esce con 4 dove
prima usciva 0 (breaking per automation che parsavano l'exit code — mitigato
dall'escape hatch e dal messaggio spine `mission-strict-blocked`).

## TODO

- [x] `strictDoneEnabled(surface)` mode-aware in `verificationBridge.ts`
- [x] Gate mission al wind-down in `runHeadless.ts` (exit 4 + evento spine)
- [x] Help `--strict-done` aggiornato con il default mission
- [x] Lock test dei default (`strictDefaults.test.ts`)
- [x] RC: rivalutare il default Kraken — **resta opt-in** (ADR-0026)
- [x] RC: `requireEventBackedEvidence` a ON nel `STRICT_BUILD_POLICY` (ADR-0026)
