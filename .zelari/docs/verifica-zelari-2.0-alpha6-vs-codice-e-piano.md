# Verifica: `Zelari_2.0_Alpha6_Stato_e_Cosa_Manca.md` vs codice — esito corretto

**Data verifica:** sessione corrente, sul tree a terra.  
**Baseline:** `v2.0.0-alpha.6` (HEAD `7db4f53`, `git describe` = `v2.0.0-alpha.6-1-g7db4f53`, main locale 1 commit oltre il tag).

> ⚠️ **Correzione formale.** Il primo verdetto emesso in questa sessione ("il documento è FALSO: il repo è a 1.46.1 e i simboli 2.0 non esistono") era basato su uno **stale checkout**: tra i due turni il repo locale è avanzato da `94ff0b8` (= `v1.46.1`) a `7db4f53` (= alpha.6 + 1 commit di docs). L'utente aveva ragione. Questo report sostituisce integralmente il precedente.

## Verdetto finale

**Il documento è VERITIERO rispetto a `v2.0.0-alpha.6`.** Tutti i claim di stato (§2) sono confermati dal codice; tutte le lacune indicate (§3–§16) sono reali e verificate come tali. Due sole imprecisioni minori, evidenziate in fondo.

## Claim-per-claim (§2 — "cosa è già chiuso")

| Claim documento | Esito | Evidenza nel codice |
|---|---|---|
| §2.1 Session spine canonica: `deriveMessages()` → `derivedToAgentMessages()` → model context | ✅ VERO | `packages/core/src/session/modelSurface.ts` (`deriveMessages`), `session/agentAdapter.ts:32` (`derivedToAgentMessages`, doc-comment "the only model-history path (ADR-0016/0021)"), test in `agentAdapter.test.ts` (E1.1). Commit `6548032` "spine as sole model-context source on headless + TUI (Exit-1)"; commit `a9cc791` "legacy context quarantine + ADR-0024" |
| §2.2 Versioni allineate alpha.6 + exports `/session` `/runtime` `/verification` `/mission` | ✅ VERO | root e `packages/core/package.json` = `2.0.0-alpha.6`; exports `./session`, `./runtime`, `./verification`, `./mission` presenti nella exports map |
| §2.3 ExecutionContext / workspace / worktree / fs / shell / subagent / profiles | ✅ VERO | `packages/core/src/runtime/`: `executionContext.ts`, `providers.ts`, `memoryProviders.ts`, `nodeProviders.ts`, `worktreeWorkspace.ts`, `profiles.ts` (+ test) |
| §2.4 Host/Profile/Phase separati, headless non è un profile | ✅ VERO | `runtime/profiles.ts` (profiles versioned), host = tui/headless/desktop/serve nel CLI; nessun profile "headless" |
| §2.5 VerificationEngine + CompletionPolicy + criteria pack + metrics + VerifierService | ✅ VERO | `packages/core/src/verification/`: `engine.ts` (`VerificationEngine`, deterministica zero-LLM), `completionPolicy.ts:14` (`CompletionPolicy`, `STRICT_ALL_POLICY`, `STRICT_BUILD_POLICY`, `evaluateCompletion`), `criteriaPack.v1.ts:31` (`codingCriteriaPack`), `metrics.ts` (false-done rate, verified solve rate, cost ratio), `verifier.ts` (`VerifierService` opt-in), `sessionEvidence.ts` (verdict ricostruibile dalla spine, E2.1) |
| §2.6 Verifier `inherit \| fixed`, provider/model effettivi registrati, fallback dichiarato | ✅ VERO | `verification/verifier.ts:5` ("model selection `inherit \| fixed`… EFFECTIVE provider/model always recorded… unparseable output degrades to a DECLARED discrete fallback"); test `verifier.test.ts` (inherit→`effectiveModel` del caller; fixed→override) |
| §2.7 Desktop: selettore "Same as current model (recommended)" / "Custom provider + model…", strict BUILD gate, Best-of-N alpha | ✅ VERO | `apps/desktop/src/components/SettingsView.tsx:613` (option `inherit` "Same as current model (recommended)"), `:615` (option `custom` "Custom provider + model…"), `:934` ("Best-of-N alpha (N=3, experimental) — never flips the deterministic gate") |
| §7 Strict gate: blocked → non-zero exit → session stopped | ✅ VERO | commit `b20034c` "strict done gate enforces the run outcome (E2.2)"; `verification/sessionEvidence.ts` (reconstruct-from-spine, "unknown ≠ pass", mai convertito in pass) |
| §8 `history_snapshot` ancora presente (compatibilità, non source of truth) | ✅ VERO | `src/cli/runHeadless.ts:394,966,1005,1115,1210,1600`; il model context ora arriva dalla spine (`headless.ts:59` doc E1.4 resume) |

## Lacune dichiarate (§3–§16) — confermate come reali

| Item | Conferma che MANCA (come dice il documento) |
|---|---|
| §3 Lock test verifier advisory (Caso 1 unknown+CONFIRMED→BLOCKED; Caso 2 PASS+REJECTED→advisory) | Nessun test end-to-end nel lifecycle Kraken: in `src/cli/kraken/*.test.ts` gli unici match "advisory" sono su `needs_more_evidence` (candidateRegistry/completionGate), non sui due casi del documento |
| §4 Criteria pack non nativo nel path Kraken | `src/cli/kraken/verificationBridge.ts` + `verifyReport.ts` (+ `CriterionSource` che include ancora `'kraken-selection'` e `'verify-agent'` in `verification/types.ts:11-17`) — il flusso passa ancora dal verify tentacle report |
| §5 EvidenceRef non event-backed | `verification/types.ts:80-92`: `EvidenceRef = { seq?: number (OPZIONALE), tier, ref: string (free-text), capturedAt, digest? }` — quando `seq` è assente e `ref` è una note dell'agente, l'evidence non è tracciata a un evento reale |
| §6 Mission progress non integrato | `packages/core/src/mission/missionState.ts` esiste ma nessun consumer di `progressScore()` nel lifecycle mission |
| §9 Desktop round-trip smoke | `verifierSettings.test.ts` esiste ma non copre persist→restart→runtime resolution→event log (nessun test round-trip) |
| §10 Profile smoke matrix | Nessuna matrice `profile × phase` (solo test unitari `runtime/profiles.test.ts`) |
| §11 GUIDA 2.0 | `docs/GUIDA.md`: **zero** occorrenze di "Session spine/deriveMessages/verifier/Strict" |
| §12 MIGRATION 2.0 | `MIGRATION.md` elenca i path 2.0 (es. riga 151 `@zelari/core/session`) ma l'header dichiara ancora "Current product line: 1.34.x" e non documenta il cambio di paradigma append-events→deriveMessages |
| §13 CI matrix | `.github/workflows/` contiene solo `ci.yml` (844 B, gate singolo), `publish.yml`, `release-desktop.yml` |

## Imprecisioni minori del documento (non invalidano il verdetto)

1. **§5 target `EvidenceRef { eventSeq, … }`**: lo schema attuale usa già `seq` (opzionale) e `digest` (opzionale) — la struttura è più vicina al target di quanto il testo suggerisca; il gap vero è che `seq` non è **obbligatoria** e `ref` free-text permette pseudo-evidence. Rinominare `seq`→`eventSeq` è un breaking change di schema da valutare in ADR, non un obbligo.
2. **§1 percentuali**: orientative (il documento stesso lo dichiara); non sono metriche estratte dal codice.

## Conclusioni operative

- Il documento è un **handoff attendibile**: usabile come baseline per Alpha.7.
- Piano implementativo conseguente: vedere `.zelari/docs/piano-2.0-alpha7-verification-nativa.md`.
- Le uniche sezioni da non prendere alla lettera sono le due imprecisioni sopra.
