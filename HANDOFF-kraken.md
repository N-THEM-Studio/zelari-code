> **SUPERSEDED** - historical snapshot; current state lives in README.md, CHANGELOG.md and docs/decisions/. Not onboarding docs.

# HANDOFF - Kraken super-agent

> **?? Historical / superseded (2026-08).** Snapshot taken while the tree was still **1.25.0**.  
> Current product: **zelari-code 1.34.0**. Do **not** use the gap table below as a backlog.
>
> Already shipped after this note:
> - **G1** live tentacle UI - Desktop Workbench Plan/Tasks (1.33)
> - **G2** worktree auto-merge - `ZELARI_KRAKEN_WORKTREE_AUTO_MERGE` (default on, 1.26-1.28)
> - **G5** release bump - 1.26 through **1.34.0**
> - **G6** P0 safety - folder trust, lifecycle hooks, `--inspect` (**1.32.0**)
> - Kraken Graph DAG, radio, model routing - 1.26-1.28
>
> Source of truth: [CHANGELOG.md](./CHANGELOG.md), [docs/GUIDA.md](./docs/GUIDA.md#kraken-super-agent--tentacoli-e-env).

---

> Original snapshot (kept for history):


> Post-push snapshot of the **Kraken** work (rename `agent` -> `kraken` + tentacles).
> Not a versioned release: `package.json` stays **1.25.0**; the notes live in `CHANGELOG` -> `[Unreleased]`.

## What is included in this push

### Identity / mode
- Canonical mode **`kraken`** (legacy aliases `agent` / `single` still accepted).
- TUI cycle: `kraken` -> `council` -> `zelari` (`shift+tab` / `/mode`).
- Mission build label: **`build@kraken`** (legacy env `ZELARI_BUILD_VIA_AGENT` unchanged).
- Prompt pack: `KRAKEN_IDENTITY_MODULE` + `KRAKEN_LEAD_PLAYBOOK_MODULE` in headless / mission slice.
- Desktop / StatusBar / overlay: **kraken** label instead of agent.

### Tentacles (`task`)
- Optional `scope[]` + `acceptance[]` contracts on the `task` schema.
- Spawn cap per parent turn: `ZELARI_KRAKEN_MAX_TASK_SPAWNS` (default 6); `resetTaskSpawnCount()` at turn start.
- **K5 model routing**: `src/cli/tools/krakenModel.ts` + lazy wiring in `toolRegistry` / sub-agent context.
- **K8 radio**: `src/cli/tools/krakenRadio.ts` -> `.zelari/radio/<session>.jsonl`; slash **`/kraken`** -> `formatKrakenRadioStatus`.
- **K7 worktree (partial)**: creates a worktree for `general` if `ZELARI_KRAKEN_WORKTREE=1`, path footer, cleanup unless `KEEP`.
- **K4 verify-hint**: footer after `task` general.
- Tests: `tests/unit/cli-kraken-slice2.test.ts` (+ mode/task/headless/prompt updates).

### Docs
- `CHANGELOG.md` `[Unreleased]`, `README.md` headless/mode, `docs/GUIDA.md` Kraken section + mode table.

## What is missing (explicit gaps)

| ID | Gap | Code state | Notes |
|----|-----|--------------|------|
| **G1** | **Live tentacle UI (K10)** | `src/cli/tools/krakenLive.ts` **present but not imported** by `taskTool` / StatusBar / Desktop | No "tentacles running/done" chip in TUI or Desktop. Wire `krakenTentacleStart/End` into `taskTool` + StatusBar props + SSE/Desktop events if needed. |
| **G2** | **Worktree auto-merge** | `isKrakenWorktreeAutoMergeEnabled` / merge helpers in `krakenWorktree.ts` **unused** by `taskTool` | Today: worktree -> run -> cleanup (or KEEP). **No merge** of the changes into the parent tree. With worktree ON without KEEP the tentacle's edits can vanish at cleanup. High priority if WORKTREE=1 is promoted. |
| **G3** | **Mid-run radio progress** | Only `spawn` / `done` / `error` / `verify_hint` events | No periodic `progress` from the sub-harness. |
| **G4** | **Auto-pick cheap async model** | Heuristics + discovery in `krakenModel.ts` | Verify the async discovery path end-to-end in the real UI; unit tests cover sync/env. |
| **G5** | **Release bump** | Still **1.25.0** | Before npm publish: bump (e.g. 1.26.0), move Unreleased -> dated section, `npm run build` + full tests. |
| **G6** | **P0 v0.10 plan safety** | Out of Kraken scope | Lifecycle hooks on AgentHarness, folder trust `/trust`, unified `inspect` - remain in the `.zelari/plan.json` backlog. |
| **G7** | **Temp scripts** | `scripts/_kraken_slice3.py`, `scripts/_fix-kraken-docs.py` | One-shot utilities; not part of the product. Excluded from the feature commit unless needed. |

## New files (feature)

- `src/cli/tools/krakenModel.ts`
- `src/cli/tools/krakenRadio.ts`
- `src/cli/tools/krakenWorktree.ts`
- `src/cli/tools/krakenLive.ts` [ **dead code until G1**
- `tests/unit/cli-kraken-slice2.test.ts`
- `HANDOFF-kraken.md` (this file)

## How to verify

```bash
npm run pretest
npx vitest run tests/unit/cli-kraken-slice2.test.ts tests/unit/cli-mode.test.ts tests/unit/cli-taskTool.test.ts
npm run typecheck
# rename smoke
node bin/zelari-code.js --help   # --mode kraken|council|zelari
```

## Recommended next steps (order)

1. **G2** - in `taskTool`, if worktree + success + auto-merge: `mergeKrakenWorktree` (or equivalent API) before cleanup; test with a temp git repo.
2. **G1** - wire `krakenLive` into `taskTool` + StatusBar (CLI minimum); Desktop after.
3. **G5** - release 1.26.0 when G2 is green (or document WORKTREE as experimental without merge).
4. Resume P0 safety (hooks / trust / inspect) from the v0.10 plan.

## Do not commit

- `Screenshot *.png`, `logozelaricode.png`, `index.html.tmp` (local artifacts)
- `.zelari/radio/`, test worktrees