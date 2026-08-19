# ADR-0023 — Verifica deterministica e CompletionPolicy (evidence contract)

**Status:** Accepted
**Date:** 2026-08-19

## Contesto

Il completion gate Kraken 1.49 (`src/cli/kraken/completionGate.ts`, ADR-0020) già
applica `unknown ≠ pass` con un repair pass, ma è tipizzato sul verify report del
tentacle, non su un contratto generale. Il piano 2.0 vuole: task semplici verificabili
senza LLM, evidenza riconducibile al tool output originale, false-done misurabile.

## Decisione

`@zelari/core/verification` introduce l'evidence contract:

- **`Criterion`** `{id, text, source: task|plan|kraken-selection|mission|criteria-pack,
  required, check?}` dove `check` è unione discriminata deterministica:
  `command` (expectExit/expectStdoutIncludes/timeout), `file-exists`, `file-contains`,
  `file-absent`, `none`.
- **`EvidenceRef`** `{seq?, tier: tool-output|command-output|fs-observation|verifier-llm|human,
  ref, capturedAt, digest?}` — il digest è sha256 dell'output; `seq` riconduce
  all'evento spine originale quando esiste.
- **`VerificationResult`** `{criterionId, status: pass|fail|unknown, source, evidence[],
  evaluatedAt, durationMs, detail?}`. **`unknown ≠ pass` ovunque**: nessuna coercizione.
- **`VerificationEngine.evaluate`** — deterministico, zero LLM: gira i check via
  ShellProvider/FsProvider e costruisce l'evidenza con digest. Check assente o
  provider mancante → `unknown` con reason, mai `pass`.
- **`CompletionPolicy`** (strict) → `PASS | REPAIR_REQUIRED | BLOCKED`:
  - required mancante o `unknown` (incluso "pass senza evidence") → non-PASS;
  - `fail` presenti → `REPAIR_REQUIRED`; solo unknown/missing → `BLOCKED`
    ("clean done senza evidence sufficiente bloccabile");
  - `strictBuildGate` è l'alias per il gate BUILD/mission (`ZELARI_STRICT_DONE=1`
    inizialmente, default in beta).
- **Criteria Pack v1** (`zelari-coding/v1`): correctness.specification (test),
  correctness.observable-output (build), correctness.error-signals (typecheck),
  quality.scope-discipline, evidence.verification-quality (required: false).
- **Metriche**: `computeFalseDoneRate` / `verifiedSolveRate` / `verificationCostRatio`.
- **VerifierService (3B, alpha) è advisory**: il suo verdict/score NON entra mai nella
  `CompletionPolicy` — nessun done basato solo sullo score, nessun bypass P2.
  Il modello effettivo (inherit|fixed) è sempre loggato nell'evento verification.

## Alternative considerate

1. **Estendere solo `completionGate` CLI** — rifiutato: il gate resterebbe legato al
   verify tentacle e non riusabile per mission/headless/Desktop.
2. **Verifica solo LLM-verifier** — rifiutato: viola "task semplici verificabili senza
   LLM" e rende il costo dei task semplici non-baseline.

## Conseguenze

**Positive** — false-done misurabile e ridotta per costruzione; evidenza auditabile
(VerificationResult → EvidenceRef → evento → tool output); CLI 1.x continua a
funzionare (l'adapter 3A.6 mappa i verify report esistenti su `VerificationResult`).

**Negative** — rigore iniziale: criteri senza check deterministico emergono come
`unknown` (volutamente onesto); il pack va collegato ai comandi reali del repo.
