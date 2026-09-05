# HANDOFF v2.30.0 - development from another machine

> Written at the release of **v2.30.0** (2026-09-05). This file is the only cross-machine vehicle of the development state: the `.zelari/` vault is **gitignored** and does NOT travel with the clone. The plan tasks (`t31`, `t51-t54`) exist only on the origin machine's `.zelari/plan.json` - everything needed is inlined here.

## State at tag v2.30.0

> **Update 2026-09-05 (post-release)**: the `v2.30.0` tag was **moved** from `8506640` (release commit) to the anti-drift fix commit, to restart the npm publish - run #188 had failed on "Run tests" due to the CRLF->LF seal-drift (see "Post-tag fix" at the bottom). Release content identical: same `2.30.0`, just the normalized seal hashes added.

Hardening plan waves **W0-W4** completed, verified and committed. Gates green at release: `verify-versions` coherent, `verify-principles` PASS 0 errors, the touched areas' test suites all green (evolution 14, antiGoodhart 14, provenance/presets/exfil 19, costBudget+memory-audit 19, paths 5, honesty.claims 10).

Commits in the release (from `ec7330f` to `39c201b` = W0-W4, then release):
`ec7330f` docs(agents) W0 -> `958e984` ci(audit) W0 -> `8f198eb` feat(evolution) W1 -> `ae8127d` feat(eval anti-Goodhart) W2 -> `991b8ea`+`1a4a681` feat/test(safety) W3 -> `ea68ead` feat(budget) W4 -> `39c201b` feat(memory) W4 -> release 2.30.0.

## WHAT IS MISSING - resume from here

### Wave 5 (planned block, in recommended order)

1. **t51 - Per-release eval snapshot in `docs/EVALS.md`** (CI or manual): run `npm run eval:gate` (or `eval:measured`) and fill the per-release/provider table per the convention already written in `docs/EVALS.md` (snapshot section). Raw results go into `eval/results/<manifest-hash>/`. Groundwork done: the published seal manifest hash is in EVALS.md. Link to **t31** (competitive benchmark vs Codex/Claude Code/OpenCode, `.zelari/plan-tasks/t31.md`, origin machine only).
2. **t52 - Dogfooding: zelari missions on zelari-code -> PR with automatic audit** - closes the ? of P1 (roadmap). Output only as a PR, never automatic merge; the PR includes the ADR-0007-style sampling audit (grep of synthesis assertions vs evidence). The guard rail already exists: `scripts/touches-judge.mjs` + `touches-judge` label (PR-only job in `ci.yml`) + hard `[judge]` check in the gate. On a PR: if the diff touches `JUDGE_PATHS` (in `scripts/verify-principles.mjs`) two approvals are required.
3. **t53 - `@zelari/core` API stability** - `AgentHarness` + `ToolRegistry` + `Ledger` as three documented public interfaces (P4); includes deciding the export semver policy.
4. **t54 - `docs/GUIDA.md` updated to the 2.29/2.30 features** - missing: `zelari.config.json` + `--print-settings`, single root `~/.zelari-code/` with migration, `/evolve` (status/fitness/proposals), `/memory audit`, `--permissions`, session budget with HOLD, provenance (strengthened asks), SSH exfil guard.

### Declared technical leftovers (mini-tasks, each half a day or less)

5. **Headless honesty stays heuristic**: `src/cli/runHeadless.ts` (~1293 council, ~1417 graph) does not pass `sessionId` to `postCouncilHook` -> `evidenceFromSpine` does not trigger, the lint degrades to legacy. Fix: bring `sessionId` into scope in the closures and pass the option (signature ready in `src/cli/workspace/postCouncilHook.ts`).
6. **Budget guard only on the council turn**: the kraken path of `src/cli/hooks/useChatTurn.ts` (~2094) has no pre-turn HOLD guard; the cumulative record at `agent_end` is global instead. Port the same guard used for the council turn (see `src/cli/costBudget.ts`).
7. **README - incomplete env table**: missing the `ZELARI_PERMISSION_PRESET` and `ZELARI_PROVENANCE` rows (documented only in `--help`/THREAT_MODEL).
8. **Hold-out anchor**: `npm run evolve:seal -- --rotation-candidates` exists but no hold-out anchor has been written/self-approved yet; the rotation (EVALS.md "rotation") still has to run for the first time.
9. **Dependabot #6**: not reproducible locally (audit 0 vulns on root and desktop lockfiles); CI now blocks on high+. After the push, check on GitHub whether the report disappears or needs triage on the `apps/desktop` lockfile.
10. **AGENTS.MD**: after this release re-run `/council` for the auto-curated refresh (decisions 0036 already inside; tech-stack auto-derived).
11. **Desktop "Evolution" panel**: backlog not started (fitness per task class + pending proposals) - requires `apps/desktop`.
12. **`.zelari/plan.json` vault**: recreate it on the other machine (or copy it by hand): t39-t50 completed, t31/t51-t54 pending. The extended roadmap is in `.zelari/docs/roadmap-hardening-2026-09.md` (also local).

## How to resume (environment)

- Node 24, `npm install` (workspace), then: `npm run typecheck` (= core build + root tsc), `npm test`, `node scripts/verify-versions.mjs`, `npm run verify:principles`.
- Conventions: atomic single-task commits (`feat(scope): ... (Wx/ty)`), **lightweight** tag `vX.Y.Z` from the release commit, `scripts/bump-version.mjs <semver>` + **manual** lockstep of `packages/core/src/version.ts` (`CORE_VERSION`) and `packages/core/README.md` (badge) - the `verify-versions` gate checks them.
- CHANGELOG: entry written by hand **before** the bump (the script's automatic insert is stale and hooks onto a non-existent 1.9.3 anchor -> does not fire).
- Security invariants not to break: ADR-0036 (proposer != measurer, `JUDGE_PATHS`), sealed anchors (drift = red gate), behavioral rule in `evolveDecide`, provenance/kill-switch `ZELARI_PROVENANCE`.

## Post-tag fix (2026-09-05, after v2.30.0)

- Sealed-anchor hashes are now computed over **LF-normalized, BOM-stripped** content in all three hashing sites (`tools/eval/sealedAnchors.ts` seal+verify, `scripts/verify-principles.mjs` gate). v2.30.0 had sealed on a Windows CRLF checkout -> CI (LF) flagged all 7 anchors as DRIFTED. All 7 re-sealed with normalized hashes; new manifest hash published in `docs/EVALS.md`. No anchor content changed. Regression test: `tools/eval/sealNormalization.test.ts`.