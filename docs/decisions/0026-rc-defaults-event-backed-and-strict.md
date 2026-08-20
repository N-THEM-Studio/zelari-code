# ADR-0026 — Default RC: evidence event-backed ON, Kraken strict resta opt-in

**Status:** Accettato
**Date:** 2026-08-20
**Sostituisce (parziale):** i TODO "rivalutare alla RC" di [ADR-0025](0025-strict-done-defaults.md)

## Contesto

Alpha.8 ha chiuso Exit-2 e Exit-3. Prima di uscire dall'alpha restavano tre
decisioni esplicite:

1. Accendere `requireEventBackedEvidence` nel `STRICT_BUILD_POLICY`.
2. Rivalutare il default Kraken strict (ADR-0025 lo lasciava opt-in fino alla RC).
3. Pubblicare `2.0.0` (non più `2.0.0-alpha.x`).

La matrice di profile smoke (Exit-3.2) dimostra che i profili caricano e
che plan strippa i mutatori. **Non** misura il costo baseline di far
girare typecheck/test/build su ogni task Kraken interattivo, né quanto
spesso un turn 1.x chiude solo con note del verify tentacle.

## Decisione

1. **`STRICT_BUILD_POLICY.requireEventBackedEvidence = true` da 2.0.0.**
   Un `pass` con sola nota (tier `tool-output` / `command-output` /
   `fs-observation` senza `EvidenceRef.seq`) è **BLOCKED**.
   Opt-out esplicito: `{ ...STRICT_BUILD_POLICY, requireEventBackedEvidence: false }`.
2. **Kraken resta opt-in** (`ZELARI_STRICT_DONE=1` / `--strict-done`).
   Accendere lo strict di default su Kraken, *con* il flag event-backed ON,
   farebbe uscire **exit 4** ogni task interattivo le cui uniche evidence
   sono note del verify tentacle **senza** emitter di spine. Il path
   produzione (`runHeadless` / TUI) passa già `emit` e ancora le note
   (`anchorSelectionEvidence`); i test e i caller senza emitter devono
   o iniettare `emit` o accettare BLOCKED. Questo è il contratto, non un
   default silenzioso su tutta la 1.x CLI.
3. **Mission resta default ON** (ADR-0025 invariato). Il pack nativo
   (`ZELARI_VERIFY_PACK`) resta opt-in su entrambe le superfici.
4. Il prodotto esce dall'alpha: versione **`2.0.0`**.

## Alternative considerate

1. **Kraken strict ON ovunque (Opzione B del documento alpha.6)** —
   rifiutato per 2.0.0: rompe il costo baseline 1.x dei task semplici
   (ogni `--task` senza check registrati resta aperto, ma ogni task con
   selection + note non ancorate diventa exit 4). Da rivalutare in 2.1
   quando il pack nativo sarà il path di default *e* ogni host passa `emit`.
2. **Tenere `requireEventBackedEvidence` OFF** — rifiutato: è il gate
   anti-false-done che il documento §5/§19 chiedeva prima della RC.
3. **Pubblicare `2.0.0-rc.1` invece di `2.0.0`** — rifiutato su richiesta
   esplicita di prodotto ("pubblica la versione 2").

## Conseguenze

**Positive** — il circuito evidence → completion è nativo *e* esigente:
niente "done" su una stringa del verify agent senza evento di sessione.

**Negative** — breaking per chi valutava `STRICT_BUILD_POLICY` in
libreria con evidence unanchored (prima PASS, ora BLOCKED). Mitigazione:
opt-out esplicito sul policy object; i caller CLI con `emit` non cambiano
verdetto.

## TODO

- [x] `requireEventBackedEvidence: true` in `STRICT_BUILD_POLICY`
- [x] `anchorSelectionEvidence()` nel bridge (note → `verification.evidence`)
- [x] Test: default ON blocca unanchored; emit ancora e PASS
- [x] ADR-0025 TODO RC spuntati / puntati qui
- [x] Bump lockstep `2.0.0`
