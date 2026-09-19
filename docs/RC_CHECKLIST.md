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
- [x] **full mission e2e** (goal + completion gate; the iteration-budget stop-rule stays on the mission unit suite) - `npm run smoke:mission` (`src/cli/headless/missionE2e.smoke.test.ts`): hermetic, no network/LLM (injected provider stream on the REAL mission loop + strict gate). A fixture `.zelari/plan.json` (2 pending tasks) derives `slice-mvp` bound to those task ids, the slice earns its real write, the mission claims done -> RED (native pack command fails) **exit 4** / GREEN (same fixture and run, only the command outcome flipped) **exit 0**
- [ ] **M2 ceiling measurement** (piano §Fase M2, M2.3/M2.4) - after a REAL mission run: `npm run mission:metrics` reports tokens/cost/repair-window from `.zelari/mission-state.json` vs the canonical ceilings (`ZELARI_MISSION_MAX_TOKENS` / `ZELARI_MISSION_MAX_COST` / `--max-repairs`; **exit 2** = over ceiling, or ceiling defined but state has no number — M2.4 unknown ≠ pass). Unit-pinned in `tests/unit/mission-metrics.test.ts`; first real measurement already recorded (piano §10 M2: dogfood `m_134ee2d0` → stopped 6/6, 15.4M tokens / $15.68, no ceiling set) — next RC runs it with `ZELARI_MISSION_MAX_TOKENS` explicit

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

## Piano & scope (post-2.0)

- [x] **scope check vs piano** - `tag-release` ora richiede `--scope=plan:<fase §4>|exception:<motivo §5>` (gate 8): rifiuta senza dichiarazione (exit 1, niente tag), accetta solo fasi whitelistate e registra la dichiarazione nel messaggio del tag annotato — audit contro la scorecard §10. Non è più solo un check manuale. Test: `tests/unit/tag-release.test.ts` **7/7 verdi, eseguiti** (fixture: stub committato + `core.autocrlf=false` nel repo temp)

---

## Verdict

Exit-2 (native Verification 2.0) and Exit-3 (surface/docs/CI) are **closed
and committed**.
**2.0.0 ships the RC defaults.** Non-blocking leftovers: graph-wide dependabot
(apps/desktop, mcps). The full mission e2e has since landed as
`npm run smoke:mission` (slice-from-plan + red -> exit 4 / green -> exit 0), so
it is no longer a 2.1 backlog item.