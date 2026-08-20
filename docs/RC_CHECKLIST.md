# RC Checklist — Zelari Code 2.0

> Stato: **chiusa per 2.0.0** — ultimo aggiornamento: `v2.0.0` (ADR-0026).
> Mappa i criteri §19 di `Zelari_2.0_Alpha6_Stato_e_Cosa_Manca.md` su evidenza reale
> (commit, test, file). Ogni riga ha: stato, evidenza, azione residua se non chiusa.

## Session

- [x] single canonical context path — `deriveMessages()` unico path (ADR-0016/0021/0024); `history_snapshot` marcato COMPAT MIRROR in `runHeadless.ts` (F13)
- [x] resume/replay smoke — `src/cli/headlessE2eSession.test.ts` (F11): turn 2 su stesso log, seq monotona
- [x] export smoke — `exportSessionPath` → export riletto con reader fresco, traiettoria identica (F11)
- [x] no legacy source-of-truth — mirror solo compatibilità, rimosso a rc (ADR-0024); verifica architetturale `legacyContextIsolation.test.ts` verde

## Verification

- [x] criteria pack realmente usato — `ZELARI_VERIFY_PACK=1` → `evaluateNativePack` nel gate Kraken (F2, `src/cli/kraken/nativeVerification.ts`)
- [x] verifier advisory lock test — `verifierAdvisoryLock.test.ts` 3/3: unknown+CONFIRMED→BLOCKED, fail+CONFIRMED→REPAIR_REQUIRED+downgrade, PASS+REJECTED→PASS intatto (F1)
- [x] evidence refs a tool/session events — `EvidenceRef.seq` → evento spine `verification.evidence` con comando/exit/digest (F3, `packages/core/src/verification/evidenceEventBacked.test.ts`)
- [x] strict completion behavior definito — ADR-0025 + ADR-0026: Kraken opt-in / Mission ON; event-backed required; exit 4
- [x] false-done test suite — lock test + gate unknown→BLOCKED + unanchored notes→BLOCKED (F1/F5/ADR-0026)
- [x] **GATE RC**: `requireEventBackedEvidence` ON in `STRICT_BUILD_POLICY` (ADR-0026); `anchorSelectionEvidence()` ancora le note quando c'è `emit`

## Profiles/runtime

- [x] profile smoke matrix — `src/cli/profileMatrix.test.ts` 9/9: minimal/kraken/council/mission × plan/build, manifest hash in session.started, plan strippa mutatori (F7)
- [x] plan/build capability tests — `PLAN_BLOCKED_TOOLS` applicato al registry; invarianti source-asserted (F7)
- [x] worktree isolation smoke — coperto dal subset CI smoke (session/runtime su 3 OS, F10); smoke dedicato worktree in `packages/core/src/runtime` incluso nella matrix
- [x] **default Kraken strict**: **resta opt-in** (ADR-0026) — ON ovunque romperebbe il costo baseline 1.x; da rivalutare in 2.1 se il pack nativo diventa default

## Mission

- [x] progress integration — continuation policy advisory, evento spine `mission.progress` con recommendation/trend (F4, `packages/core/src/mission/continuationPolicy.ts`)
- [x] interrupt/resume — mission run = loop headless reale, resume via `resumeSessionId` (F11 copre kraken/council; mission loop completo escluso dallo smoke e documentato)
- [x] evidence-based completion — mission strict gate ON di default (ADR-0025); blocked → `mission-strict-blocked` + exit 4 (F5)
- [ ] **e2e mission completo** (goal + completion gate + budget) — backlog esplicito: non è la superficie resume/export di §14, da aggiungere come smoke prodotto in beta

## Desktop

- [x] inherit verifier smoke — `verifierRoundTrip.test.ts`: Primary A + inherit → effective A, selectionMode inherit (F6)
- [x] dedicated verifier smoke — Primary A + override B → effective B anche con sessione su A (F6)
- [x] reset/fallback smoke — clear override → di nuovo inherit A (F6)
- [x] persistenza/reload — canale reale `applySetConfig` → `provider.json` → fresh disk read → risoluzione (F6)
- [x] Desktop shell 2.0.0 lockstep — `apps/desktop` package.json + tauri.conf.json + Cargo.toml/lock; Settings → App updates follows `/releases/latest`; Update CLI follows npm `latest`

## Docs

- [x] GUIDA 2.0 — `docs/GUIDA.md` +155: host/profile/phase, spine, resume/fork/export, strict/verifier, BoN alpha (F8)
- [x] MIGRATION 2.0 — `MIGRATION.md`: append-events → deriveMessages → AgentHarness, breaking changes alpha, legacy mirror (F9)
- [x] flag alpha documentati — env table in GUIDA (ZELARI_STRICT_DONE, ZELARI_MISSION_STRICT, ZELARI_VERIFY_PACK, ZELARI_SESSIONS_DIR) + doc triage

## CI/security

- [x] OS matrix minima — `ci.yml`: verify (ubuntu Node 24) + smoke su 3 OS × Node 24 (F10)
- [x] Node versions supportate testate — matrix Node **24** (3 OS); gamba Windows verificata localmente. **Node 20 rimosso dalla matrix**: il suo npm 10.x e npm ≥11.7 calcolano ideal-tree inconciliabili per il peer esbuild di vite 8 (`^0.27||^0.28` vs root `^0.25` → nessun lockfile soddisfa entrambi), e Node 20 è deprecato sui runner GitHub. `engines.node` richiede ora `>=24` e `engines.npm` `>=11.7`.
- [x] dependency alerts triaggiati — `docs/security/dependency-triage-2.0.0-alpha.7.md`: 3 high dev-only → fix → `found 0 vulnerabilities` (F12)
- [x] principles/version/typecheck/tests verdi — gate locale completo e prepublish verde su Node 24/npm 11.7
- [x] **CI reale su GitHub** — commit `b5837fd` verde; install npm 11.7 e smoke Node 24 confermati nella matrix corrente
- [ ] **Dependabot graph-wide** — audit locali root e Desktop a zero; elenco GitHub da confermare con un token autorizzato agli alert di sicurezza (API attuale: 403)
- [x] macOS runner — il successivo workflow Desktop `v2.1.0` e la CI corrente hanno completato correttamente; failure infrastrutturale #46 superata

---

## Verdetto

Exit-2 (Verification 2.0 nativa) e Exit-3 (surface/docs/CI) sono **chiuse e committate**.
**2.0.0 pubblica i default RC.** Residuo non bloccante: dependabot graph-wide (apps/desktop, mcps) e e2e mission completo (backlog 2.1).
