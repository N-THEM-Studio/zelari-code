> **SUPERSEDED** - historical snapshot; current state lives in README.md, CHANGELOG.md and docs/decisions/. Not onboarding docs.

# HANDOFF - Zelari 2.0 Alpha (state as of 2026-08-19)

> Continuity document to resume the work from another machine.
> Source of truth: the repo itself (this file is the map, not the law).
> Reference plan: alpha -> 2.0.0 exit plan (phases Exit-0..Exit-4, criteria C1-C8).

## Current release

- `zelari-code` + `@zelari/core` lockstep **`2.0.0-alpha.6`** (tag `v2.0.0-alpha.6`, OIDC tag-driven publish).
- npm dist-tag: `alpha` (latest stays 1.49.0 until 2.0.0 ships).
- CI on main: typecheck -> tests -> `verify:principles` -> `verify:versions`.

## Exit plan progress

### Exit-0 - Unblocks ? COMPLETE (in 2.0.0-alpha.5)

- E0.1 fix `loadProviderConfig()` async: shared `mergeStoredProviderConfig` + `applyEnvOverrides` (sync/async parity, `krakenVerifier` included).
- E0.2 verifier round-trip tests (`src/cli/providerConfig.test.ts`, 7 tests).
- E0.3 README/GUIDA without hardcoded versions ("1.35.1" removed).
- E0.4 `scripts/verify-versions.mjs`: clean README gate + GUIDA lockstep.
- E0.5 CHANGELOG alpha->2.0 section.

### Exit-1 - Session spine = single source of truth ? COMPLETE (alpha.5 + alpha.6)

- **E1.1** `derivedToAgentMessages()` in core (`packages/core/src/session/agentAdapter.ts`), exported from `@zelari/core/session`.
- **E1.2** headless (kraken/council/zelari): model context seeded from spine -> `deriveMessages` -> adapter; `--history` = one-shot import into a fresh log; resume wins over legacy; declared fallback if the spine is degraded (`ZELARI_SESSION_SPINE=0`).
- **E1.3** TUI (`useChatTurn.ts`): same path; shared policy `derivedModelSeed()` (compact->user, orphan tools excluded).
- **E1.4** Desktop multi-turn from spine: `session_started{sessionId}` event -> `RunTaskArgs.sessionId` -> Rust `--resume`; `--history` stays as fallback.
- **E1.5** budget pipeline measures the spine-derived seed (both TUI paths); `compactInPlace()` removed from the council; `session_compacted` also emitted by the council; `sessionManager` deprecated for model context.
- **E1.6/E1.7** CI replay+invariant gate (`src/cli/sessionReplayInvariant.test.ts`): history rebuildable from the JSONL alone; model-visible ? logged.
- **E1.8** ADR `docs/decisions/0024-single-write-model-context.md` (dual-write closure).

Commits: `41a6271` (E0), `6548032` (E1.1-E1.7), `486cfa2` (alpha.5 bump), `47824d5` (E1.4), `a9cc791` (E1.5+E1.8).

### Exit-2 - Verification as the "done" policy ?? PARTIAL

- **E2.1 ?** verdict rebuildable from the spine: `packages/core/src/verification/sessionEvidence.ts` (`lastVerificationRun`, `snapshotToCompletionEvaluation`), `SessionSpineMirror.lastVerificationRun()`, `evaluateStrictBuildGateFromSession()`. Commit `0850baa`.
- **E2.2 ?** strict done gate enforcement: `STRICT_BUILD_POLICY` in core (deterministic tiers only: tool/command/fs/human - `verifier-llm` NOT admissible alone); `ZELARI_STRICT_DONE=1` + gate blocked after repair -> exit code **4**, spine `stopped`, NDJSON with the verdict. TUI: "turn is NOT verified-complete" notice. Commit `b20034c`.
- **E2.3 ?** verifier advisory-only lock test (opt-in) - largely covered by the E2.2 tier gate; still to verify the VerifierService opt-in.
- **E2.4 ?** coding criteria pack applied to the verify path.
- **E2.5 ?** mission progress tracker (advisory, early-stop signal).

### Exit-3 - Product surface, docs, CI ? TO DO

- E3.1 Desktop verifier UI: **already exists** (`apps/desktop/src/components/SettingsView.tsx` inherit/custom+clear); remaining: post-E0.1 round-trip smoke.
- E3.2 documented profiles + smoke (`minimal`/`kraken`/`council`/`mission`).
- E3.3 GUIDA.md: 2.0 sessions, resume/export, verification, profiles (note: `docs/SESSION-FORMAT-2.0.md` already exists, the main GUIDA needs updating).
- E3.4 MIGRATION.md for `@zelari/core` consumers (history path changed).
- E3.5 mandatory PR CI matrix.
- E3.6 headless smoke kraken+council+Session JSON export.
- **Dependabot: 10 alerts on main (3 high, 7 moderate)** - evaluate before the next tag.

### Exit-4 - RC -> 2.0.0 ?

RC.1-RC.5 per the plan (tag `v2.0.0-rc.1` only with Exit-1 complete V and Exit-0/2/3 without P0s; soak; breaking changelog; lockstep publish).

## How to resume (quick start on a new PC)

```bash
git pull
npm install
npm run typecheck && npm test          # ~3332 tests expected, 0 failures
npm run test:session                   # spine/replay/invariants gate (13 files)
node scripts/verify-versions.mjs       # versions gate
npm run verify:principles              # principles gate
```

Recommended next slice: **E2.3 + E2.4** (they close Exit-2), then Exit-3.

## Operational conventions (learned in the field)

- **Atomic commits** per logical slice; push to `main`; **lightweight** tags `v*.*.*` -> the `publish.yml` workflow publishes core+CLI via OIDC (no local token; `npm whoami` gives ENEEDAUTH by design).
- **Lockstep bump**: root `package.json` (version + exact devDep `@zelari/core`), `packages/core/package.json`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package-lock.json` (`npm install --package-lock-only`), `docs/GUIDA.md`, `CHANGELOG.md` (`[Unreleased]` -> `[x.y.z] - date`). The `verify:versions` gate checks all of it.
- **Mixed EOLs**: `src/cli/*.ts` and Rust are often CRLF -> for programmatic edits use Node scripts with replace + occurrence assertions (never multiline `sed`).
- **Never cwd-relative paths in tests that read sources**: the `npm test --workspace=@zelari/core` command runs `vitest run --root ../..` with **CWD=`packages/core`** - a test reading files via cwd-relative paths resolves from the root and **fails in CI** (it happened to `legacyContextIsolation.test.ts` on the first alpha.6 publish attempt; fix `d1c33c9`: resolve from `import.meta.url`, `../..` = repo root both from `src/cli` and `dist/cli`).
- **Tests**: explicit imports from `vitest` (globals OFF); spine tests use `mkdtemp` + `SessionSpineMirror`/`openSessionLog`.
- **Architectural gates** in `src/cli/legacyContextIsolation.test.ts`: no second history brain - if you break a rule there, you have reintroduced dual-write.
- Key plan lines: do **not** do BoN/LLaV/remote sandbox/new council roles before 2.0.0; experimental features only behind `ZELARI_*` flags.

## Hot file map

| Area | Files |
|---|---|
| CLI spine | `src/cli/sessionSpine.ts`, `src/cli/headlessSpine.ts`, `src/cli/runHeadless.ts` |
| TUI | `src/cli/hooks/useChatTurn.ts`, `src/cli/hooks/conversationContext.ts` |
| Core adapter/policy | `packages/core/src/session/agentAdapter.ts`, `packages/core/src/session/modelSurface.ts`, `packages/core/src/verification/completionPolicy.ts`, `packages/core/src/verification/sessionEvidence.ts` |
| Verification bridge | `src/cli/kraken/verificationBridge.ts` |
| Desktop | `apps/desktop/src/App.tsx`, `apps/desktop/src/types.ts`, `apps/desktop/src-tauri/src/lib.rs` |
| Gates | `scripts/verify-versions.mjs`, `scripts/verify-principles.mjs`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml` |

## Metrics (baseline -> now)

| Metric | Alpha.4 | Now (alpha.6) | 2.0 target |
|---|---|---|---|
| Model context path | legacy + mirror | `deriveMessages(Session)` only on headless+TUI V | V |
| Dual-write model context | yes | no (ADR-0024) V | V |
| README version | 1.35.1 stale | npm badge + gate V | V |
| Verifier round-trip async | bug | fixed + 7 tests V | V |
| Done without evidence (strict) | possible | exit 4 + spine stopped V | V |
| Replay/invariant in CI | partial | `test:session` gate V | V |
| Verification verdict from spine | no | `lastVerificationRun` V | V |

## 2.0 Definition of Done (reminder)

> Headless and TUI build the model context only from the Session 2.0 V, deterministic verification governs "done" in strict mode V (with tier gate), versions/docs/CI tell the same 2.0 story (main docs still to align -> Exit-3).