> **SUPERSEDED** - historical snapshot; current state lives in README.md, CHANGELOG.md and docs/decisions/. Not onboarding docs.

# HANDOFF — Zelari 2.0 Alpha (stato al 2026-08-19)

> Documento di continuità per riprendere il lavoro da un'altra macchina.
> Fonte di verità: il repo stesso (questo file è la mappa, non la legge).
> Piano di riferimento: exit plan alpha → 2.0.0 (fasi Exit-0…Exit-4, criteri C1–C8).

## Release corrente

- `zelari-code` + `@zelari/core` lockstep **`2.0.0-alpha.6`** (tag `v2.0.0-alpha.6`, publish OIDC tag-driven).
- Dist-tag npm: `alpha` (latest resta 1.49.0 finché non esce 2.0.0).
- CI su main: typecheck → test → `verify:principles` → `verify:versions`.

## Avanzamento exit plan

### Exit-0 — Sblocchi ✅ COMPLETA (in 2.0.0-alpha.5)

- E0.1 fix `loadProviderConfig()` async: merge condivisa `mergeStoredProviderConfig` + `applyEnvOverrides` (parità sync/async, `krakenVerifier` incluso).
- E0.2 test round-trip verifier (`src/cli/providerConfig.test.ts`, 7 test).
- E0.3 README/GUIDA senza versioni hardcoded ("1.35.1" rimosso).
- E0.4 `scripts/verify-versions.mjs`: gate README clean + GUIDA lockstep.
- E0.5 CHANGELOG sezione alpha→2.0.

### Exit-1 — Session spine = unica source of truth ✅ COMPLETA (alpha.5 + alpha.6)

- **E1.1** `derivedToAgentMessages()` in core (`packages/core/src/session/agentAdapter.ts`), export `@zelari/core/session`.
- **E1.2** headless (kraken/council/zelari): seed del model context da spine → `deriveMessages` → adapter; `--history` = import one-shot in log fresco; resume vince su legacy; fallback dichiarato se spine degradata (`ZELARI_SESSION_SPINE=0`).
- **E1.3** TUI (`useChatTurn.ts`): stesso path; policy condivisa `derivedModelSeed()` (compcatto→user, tool orfani esclusi).
- **E1.4** Desktop multi-turn da spine: evento `session_started{sessionId}` → `RunTaskArgs.sessionId` → Rust `--resume`; `--history` resta fallback.
- **E1.5** budget pipeline misura il seed spine-derived (entrambi i path TUI); `compactInPlace()` rimosso dal council; `session_compacted` emesso anche dal council; `sessionManager` deprecato per il model context.
- **E1.6/E1.7** gate CI replay+invariante (`src/cli/sessionReplayInvariant.test.ts`): history ricostruibile dal solo JSONL; model-visible ⊆ logged.
- **E1.8** ADR `docs/decisions/0024-single-write-model-context.md` (chiusura dual-write).

Commit: `41a6271` (E0), `6548032` (E1.1–E1.7), `486cfa2` (bump alpha.5), `47824d5` (E1.4), `a9cc791` (E1.5+E1.8).

### Exit-2 — Verification come policy di "done" 🟡 PARZIALE

- **E2.1 ✅** verdetto ricostruibile dalla spine: `packages/core/src/verification/sessionEvidence.ts` (`lastVerificationRun`, `snapshotToCompletionEvaluation`), `SessionSpineMirror.lastVerificationRun()`, `evaluateStrictBuildGateFromSession()`. Commit `0850baa`.
- **E2.2 ✅** strict done gate enforcement: `STRICT_BUILD_POLICY` in core (tier deterministici solo: tool/command/fs/human — `verifier-llm` NON ammissibile da solo); `ZELARI_STRICT_DONE=1` + gate blocked dopo repair → exit code **4**, spine `stopped`, NDJSON col verdetto. TUI: notice "turn is NOT verified-complete". Commit `b20034c`.
- **E2.3 ⬜** lock test verifier advisory-only (opt-in) — in gran parte coperto dal tier-gate E2.2; resta verificare l'opt-in del VerifierService.
- **E2.4 ⬜** criteria pack coding applicato al path verify.
- **E2.5 ⬜** progress tracker mission (advisory, early-stop signal).

### Exit-3 — Product surface, docs, CI ⬜ DA FARE

- E3.1 Desktop verifier UI: **già esistente** (`apps/desktop/src/components/SettingsView.tsx` inherit/custom+clear); resta smoke round-trip post-E0.1.
- E3.2 profili documentati + smoke (`minimal`/`kraken`/`council`/`mission`).
- E3.3 GUIDA.md: sessioni 2.0, resume/export, verification, profili (nota: `docs/SESSION-FORMAT-2.0.md` esiste già, la GUIDA principale è da aggiornare).
- E3.4 MIGRATION.md per consumer `@zelari/core` (history path cambiato).
- E3.5 CI matrix PR obbligatoria.
- E3.6 smoke headless kraken+council+export Session JSON.
- **Dipendabot: 10 alert su main (3 high, 7 moderate)** — valutare prima del tag successivo.

### Exit-4 — RC → 2.0.0 ⬜

RC.1–RC.5 come da piano (tag `v2.0.0-rc.1` solo con Exit-1 completa ✓ e Exit-0/2/3 senza P0; soak; changelog breaking; publish lockstep).

## Come riprendere (quick start su nuovo PC)

```bash
git pull
npm install
npm run typecheck && npm test          # ~3332 test attesi, 0 fail
npm run test:session                   # gate spine/replay/invarianti (13 file)
node scripts/verify-versions.mjs       # gate versioni
npm run verify:principles              # gate principi
```

Prossima slice consigliata: **E2.3 + E2.4** (chiudono Exit-2), poi Exit-3.

## Convenzioni operative (imparate sul campo)

- **Commit atomici** per slice logica; push su `main`; **tag lightweight** `v*.*.*` → il workflow `publish.yml` pubblica core+CLI via OIDC (nessun token locale; `npm whoami` dà ENEEDAUTH by design).
- **Bump lockstep**: root `package.json` (version + devDep `@zelari/core` exact), `packages/core/package.json`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package-lock.json` (`npm install --package-lock-only`), `docs/GUIDA.md`, `CHANGELOG.md` (`[Unreleased]` → `[x.y.z] - data`). Il gate `verify:versions` verifica tutto.
- **EOL misti**: `src/cli/*.ts` e Rust sono spesso CRLF → per edit programmatici usare script Node con replace + assertion sulle occorrenze (mai `sed` multilinea).
- **Mai path relativi a `process.cwd()` nei test che leggono sorgenti**: il comando `npm test --workspace=@zelari/core` gira `vitest run --root ../..` con **CWD=`packages/core`** — un test che legge file con path cwd-relativi passa dalla root e **fallisce in CI** (è successo a `legacyContextIsolation.test.ts` al primo tentativo di publish alpha.6; fix `d1c33c9`: risolvere da `import.meta.url`, `../..` = repo root sia da `src/cli` sia da `dist/cli`).
- **Test**: import esplicito da `vitest` (globals OFF); i test spine usano `mkdtemp` + `SessionSpineMirror`/`openSessionLog`.
- **Gate architetturali** in `src/cli/legacyContextIsolation.test.ts`: niente secondo cervello history — se rompi una regola lì, hai reintrotrodotto dual-write.
- Righe chiave del piano: **non** fare BoN/LLaV/sandbox remoto/nuovi ruoli council prima di 2.0.0; feature sperimentali solo dietro `ZELARI_*` flag.

## Mappa file caldi

| Area | File |
|---|---|
| Spine CLI | `src/cli/sessionSpine.ts`, `src/cli/headlessSpine.ts`, `src/cli/runHeadless.ts` |
| TUI | `src/cli/hooks/useChatTurn.ts`, `src/cli/hooks/conversationContext.ts` |
| Adapter/policy core | `packages/core/src/session/agentAdapter.ts`, `packages/core/src/session/modelSurface.ts`, `packages/core/src/verification/completionPolicy.ts`, `packages/core/src/verification/sessionEvidence.ts` |
| Bridge verification | `src/cli/kraken/verificationBridge.ts` |
| Desktop | `apps/desktop/src/App.tsx`, `apps/desktop/src/types.ts`, `apps/desktop/src-tauri/src/lib.rs` |
| Gate | `scripts/verify-versions.mjs`, `scripts/verify-principles.mjs`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml` |

## Metriche (baseline → ora)

| Metrica | Alpha.4 | Ora (alpha.6) | Target 2.0 |
|---|---|---|---|
| Path model context | legacy + mirror | solo `deriveMessages(Session)` su headless+TUI ✓ | ✓ |
| Dual-write model context | sì | no (ADR-0024) ✓ | ✓ |
| README version | 1.35.1 stale | badge npm + gate ✓ | ✓ |
| Verifier round-trip async | bug | fix + 7 test ✓ | ✓ |
| Done senza evidence (strict) | possibile | exit 4 + spine stopped ✓ | ✓ |
| Replay/invariante in CI | parziali | gate `test:session` ✓ | ✓ |
| Verification verdict da spine | no | `lastVerificationRun` ✓ | ✓ |

## Definition of Done 2.0 (ricordo)

> Headless e TUI costruiscono il contesto del modello solo dalla Session 2.0 ✓, la verification deterministica governa il "done" in strict mode ✓ (con tier gate), versioni/docs/CI raccontano la stessa 2.0 (docs principali ancora da allineare → Exit-3).
