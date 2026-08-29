# ADR-0030 — Razionalizzazione default HARNESS-10: strict-done e verify-pack ON, trust headless UNTRUSTED

**Status:** Accettato
**Date:** 2026-08-23
**Razionalizza (non riscrive):** [ADR-0025](0025-strict-done-defaults.md), [ADR-0026](0026-rc-defaults-event-backed-and-strict.md), [ADR-0027](0027-strict-kraken-default-2-1.md)
**Contesto:** piano HARNESS-10, sezione 6 (verificationBridge) — item 6.4, 6.5, 6.7

## Contesto

Gli ADR-0025 → 0027 raccontano l'evoluzione dei default di verifica per
superficie: mission strict-ON dal principio (0025), evidence event-backed ON
alla RC (0026), Kraken **opt-in** con il pack nativo come candidato al default
(0027), pack adattivo con default delegato all'host (0028).

Il ciclo di hardening HARNESS-10 (2.15+) ha però **messo in codice** quello che
quegli ADR lasciavano come opzione o come promessa futura:

1. **P0.1 — strict done default ON anche su Kraken.** `strictDoneEnabled()`
   in `src/cli/kraken/verificationBridge.ts` restituisce `true` senza env;
   `ZELARI_STRICT_DONE=0|false` è l'unico opt-out (test di lock:
   `strictDefaults.test.ts`).
2. **P0.2 — native criteria pack default ON.** `nativePackEnabled()` in
   `src/cli/kraken/nativeVerification.ts` restituisce `true` senza env; la
   gate BUILD headless si apre con `(selection || nativePackEnabled())`
   (`runHeadless.ts`) e `ZELARI_VERIFY_PACK=0|off|false` è l'unico opt-out
   (test di lock: `nativeVerification.test.ts`,
   `headless-verify-pack-default.test.ts`).
3. **§6.7 — trust headless: default UNTRUSTED (invariato).** Un folder non
   fidato non carica né project hooks (`.zelari/hooks/`) né project MCP
   (`.zelari/mcp.json`); `zelari-code --trust` (`trustFolder()`, main.ts) o
   `ZELARI_FOLDER_TRUST` abilitano esplicitamente (test di lock:
   `headless-folder-trust.test.ts`).
4. **§6.6 — igiene residua (t31):** diagnostics post-execute sui path
   sorgente claimati da bash/exec_process, stesso motore e stesso canale
   (`value.diagnostics`) del loop post-edit; item 6.4 limitato a copertura
   di verifica sulla superficie headless BUILD.

I vecchi ADR sono immutabili per policy ("ogni decisione è immutabile una
volta accettata; i cambiamenti avvengono scrivendo un nuovo ADR"): restano
la registrazione storica fedele dell'era opt-in, ma **non descrivono più il
comportamento del prodotto** sui default di Kraken.

## Decisione

**Il codice vince: i default correnti sono la decisione di prodotto.**

1. **Kraken: strict-done ON e verify-pack ON restano i default.** Non si
   riallinea il codice agli ADR-0025/0026/0027; si riallineano i documenti a
   questo ADR, che segna quei tre ADR come *parzialmente superseded* sulla
   sola questione del default Kraken. Il rationale dell'epoca (costo
   baseline 1.x, smoke matrix) è stato superato dai fatti HARNESS-10: la
   repair pass automatica (budget = 1) assorbe la maggioranza dei blocchi,
   l'anchoring evidence è tool-backed (T5) e il pack è repo-adattivo — un
   repo senza comandi deterministi non riceve blocker impossibili.
2. **Gli opt-out restano identici e documentati** — nessun restringimento:
   `ZELARI_STRICT_DONE=0|false` (kraken), `ZELARI_MISSION_STRICT=0|false`
   (mission), `ZELARI_VERIFY_PACK=0|off|false` (pack). I flag CLI
   `--no-strict-done` e le varianti explicit-on restano.
3. **§6.7: il default untrusted NON cambia.** È l'unico punto in cui HARNESS-10
   *conferma* il comportamento pre-esistente: l'esecuzione di codice
   project-scoped (hooks/MCP) richiede un atto esplicito di fiducia. Questo
   è security-by-default, non un default da rivedere.
4. **Copertura di verifica obbligatoria** sui tre punti (già in suite):
   default ON headless BUILD per il pack, opt-out esplicito, default
   untrusted con abilitazione via `--trust`.

## Alternative considerate

1. **Riscrivere ADR-0025/0026/0027** — rifiutato: viola la policy di
   immutabilità della directory e cancellerebbe il tracciato decisionale
   (perché il default era opt-in, e cosa lo ha cambiato).
2. **Riportare il codice a opt-in** — rifiutato: regressione del false-done
   guard esattamente dove l'hardening l'ha chiuso; gli opt-out esistono già
   per chi li vuole.
3. **Default trusted in headless per "comodità CI"** — rifiutato: carica
   codice dal repo senza consenso esplicito; `ZELARI_FOLDER_TRUST=1` resta
   l'escape hatch documentato per CI fidate.

## Conseguenze

**Positive** — un unico punto di verità per i default (questo ADR); i lock
test rendono i default un contratto verificabile; gli ADR storici restano
intatti come registro.

**Negative** — chi ha letto solo gli ADR-0025→0027 si aspetta opt-in: la
mitigazione è il link incrociato (qui → loro, e indice README) e gli opt-out
unchanged.

## TODO

- [x] §6.5: lock test strict-done default ON (`strictDefaults.test.ts`)
- [x] §6.4: copertura headless BUILD pack default ON / off con env
      (`headless-verify-pack-default.test.ts`, `nativeVerification.test.ts`)
- [x] §6.7: regression test trust headless (`headless-folder-trust.test.ts`)
- [x] §6.6 (t31): diagnostics post-execute su path sorgente claimati
      (`cli-execDiagnostics.test.ts`)
- [x] Indice README aggiornato con questo ADR
