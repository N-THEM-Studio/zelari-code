# RC Checklist - Zelari Code 2.0

> Status: **closed for 2.0.0** - last update: `v2.0.0` (ADR-0026).
> Maps the criteria of `Zelari_2.0_Alpha6_Stato_e_Cosa_Manca.md` onto real
> evidence (commits, tests, files). Every row has: status, evidence, residual
> action if not closed.

## Session

- [x] single canonical context path - `deriveMessages()` the only path (ADR-0016/0021/0024); `history_snapshot` marked COMPAT MIRROR in `runHeadless.ts` (F13)
- [x] resume/replay smoke - `src/cli/headlessE2eSession.test.ts` (F11): turn 2 on the same log, monotonic seq
- [x] export smoke - `exportSessionPath` -> export re-read with a fresh reader, identical trajectory (F11)
- [x] no legacy source-of-truth - mirror for compatibility only, removed at rc (ADR-0024); architectural check `legacyContextIsolation.test.ts` green

## Verification

- [x] criteria pack actually used - `ZELARI_VERIFY_PACK=1` -> `evaluateNativePack` in the Kraken gate (F2, `src/cli/kraken/nativeVerification.ts`)
- [x] verifier advisory lock test - `verifierAdvisoryLock.test.ts` 3/3: unknown+CONFIRMED->BLOCKED, fail+CONFIRMED->REPAIR_REQUIRED+downgrade, PASS+REJECTED->PASS intact (F1)
- [x] evidence refs to tool/session events - `EvidenceRef.seq` -> spine event `verification.evidence` with command/exit/digest (F3, `packages/core/src/verification/evidenceEventBacked.test.ts`)
- [x] strict completion behavior defined - ADR-0025 + ADR-0026: Kraken opt-in / Mission ON; event-backed required; exit 4
- [x] false-done test suite - lock test + gate unknown->BLOCKED + unanchored notes->BLOCKED (F1/F5/ADR-0026)
- [x] **RC GATE**: `requireEventBackedEvidence` ON in `STRICT_BUILD_POLICY` (ADR-0026); `anchorSelectionEvidence()` anchors the notes when `emit` exists

## Profiles/runtime

- [x] profile smoke matrix - `src/cli/profileMatrix.test.ts` 9/9: minimal/kraken/council/mission x plan/build, manifest hash in session.started, plan strips mutators (F7)
- [x] plan/build capability tests - `PLAN_BLOCKED_TOOLS` applied to the registry; invariants source-asserted (F7)
- [x] worktree isolation smoke - covered by the CI smoke subset (session/runtime on 3 OS, F10); dedicated worktree smoke in `packages/core/src/runtime` included in the matrix
- [x] **default Kraken strict**: **stays opt-in** (ADR-0026) - ON everywhere would break the 1.x cost baseline; to be reconsidered in 2.1 if the native pack becomes default

## Mission

- [x] progress integration - continuation policy advisory, spine event `mission.progress` with recommendation/trend (F4, `packages/core/src/mission/continuationPolicy.ts`)
- [x] interrupt/resume - mission run = real headless loop, resume via `resumeSessionId` (F11 covers kraken/council; full mission loop excluded from the smoke and documented)
- [x] evidence-based completion - mission strict gate ON by default (ADR-0025); blocked -> `mission-strict-blocked` + exit 4 (F5)
- [ ] **full mission e2e** (goal + completion gate + budget) - explicit backlog: it is not the resume/export surface of F14, to be added as a product smoke in beta

## Desktop

- [x] inherit verifier smoke - `verifierRoundTrip.test.ts`: Primary A + inherit -> effective A, selectionMode inherit (F6)
- [x] dedicated verifier smoke - Primary A + override B -> effective B even with the session on A (F6)
- [x] reset/fallback smoke - clear override -> inherit A again (F6)
- [x] persistence/reload - real channel `applySetConfig` -> `provider.json` -> fresh disk read -> resolution (F6)
- [x] Desktop shell 2.0.0 lockstep - `apps/desktop` package.json + tauri.conf.json + Cargo.toml/lock; Settings -> App updates follows `/releases/latest`; Update CLI follows npm `latest`

## Docs

- [x] GUIDA 2.0 - `docs/GUIDA.md` +155: host/profile/phase, spine, resume/fork/export, strict/verifier, BoN alpha (F8)
- [x] MIGRATION 2.0 - `MIGRATION.md`: append-events -> deriveMessages -> AgentHarness, alpha breaking changes, legacy mirror (F9)
- [x] alpha flags documented - env table in GUIDA (ZELARI_STRICT_DONE, ZELARI_MISSION_STRICT, ZELARI_VERIFY_PACK, ZELARI_SESSIONS_DIR) + triage doc

## CI/security

- [x] minimal OS matrix - `ci.yml`: verify (ubuntu Node 24) + smoke on 3 OS x Node 24 (F10)
- [x] supported Node versions tested - Node **24** matrix (3 OS); Windows leg verified locally. **Node 20 removed from the matrix**: its npm 10.x and npm <11.7 compute irreconcilable ideal-trees for vite 8's esbuild peer (`^0.27||^0.28` vs root `^0.25` -> no lockfile satisfies both), and Node 20 is deprecated on GitHub runners. `engines.node` now requires `>=24` and `engines.npm` `>=11.7`.
- [x] dependency alerts triaged - `docs/security/dependency-triage-2.0.0-alpha.7.md`: 3 high dev-only -> fixed -> `found 0 vulnerabilities` (F12)
- [x] principles/version/typecheck/tests green - full local gate and prepublish green on Node 24/npm 11.7
- [x] **real CI on GitHub** - commit `811f6dd` green; npm 11.7 install and Node 24 smoke confirmed in the current matrix
- [ ] **Dependabot graph-wide** - local root and Desktop audits at zero; the GitHub list to be confirmed with a token authorized for security alerts (current API: 403)
- [x] macOS runner - the later Desktop workflow `v2.1.0` and the current CI completed correctly; infrastructure failure #46 overcome

---

## Verdict

Exit-2 (native Verification 2.0) and Exit-3 (surface/docs/CI) are **closed
and committed**.
**2.0.0 ships the RC defaults.** Non-blocking leftovers: graph-wide dependabot
(apps/desktop, mcps) and the full mission e2e (2.1 backlog).