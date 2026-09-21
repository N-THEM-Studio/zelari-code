# EVALS.md — Evaluation method and published results

> How Zelari Code measures itself (P1 applied to the product). The eval
> harness lives in `tools/eval/`; anchors in `eval/anchors/`; retention gate
> in `.github/workflows/eval-retention-gate.yml`.

## Principles

- **Deterministic first**: a run either reproduces or it doesn't count. Gates
  compare against a **stable tag baseline** keyed by the **harness manifest
  hash** — change the tool surface and historical fitness expires.
- **Tiered evidence** (`tools/eval/types.ts`): every check carries a tier
  (0/1/2). Tier-0 anchors are the sealed core: they gate releases and are
  **off-limits to the evolution loop** (ADR-0036 proposer/judge separation).
- **No LLM-as-judge as a promotion source**: model judgments cap at tier
  `claimed`. PASS authority = deterministic gates only.

## Tooling

| Command | Purpose |
|---|---|
| `npm run eval:gate` | Deterministic gate run (`tools/eval/runGate.ts`) vs the stable-tag baseline |
| `npm run eval:measured` | Measured eval pass with cost/latency capture |
| `npm run bench:competitive` | Competitive benchmark vs other CLI agents (results under `eval/results/competitive/`) |
| `npm run evolve:propose` | Evolution proposals from the ledger/store — proposes only, never applies |
| `npm run evolve:decide` | Human decision loop on proposals (evidence required, fail-closed for `applied`) |
| `npm run evolve:validate` | Validation of decided proposals |

Dev overrides: `ZELARI_EVAL_RESULTS_DIR` relocates the result store (test/CI).

## Result store layout

Results are stored per **harness manifest hash** (`eval/results/<hash>/`),
plus `eval/results/competitive/` for the cross-agent benchmark. Each entry
records the manifest hash, provider/model, per-anchor verdicts with tier,
cost, and latency. Because the key is the manifest hash, results from a
changed tool surface never silently mix with old ones.

## Reproducing a gate run

```bash
npm run eval:gate          # from a clean checkout, same Node major as CI (24.x)
```

The retention gate (CI) fails a release when the current run regresses
against the recorded stable-tag baseline for the same manifest hash.

## Measurement protocol (2.31+)

One discipline, half a page:

- **Default `--runs 3`** on the competitive bench (override: `--runs N`).
  A single run is an anecdote; three make a median and a spread.
- **`model` in every record is valued or `'undeclared'`** — never a silent
  `null`. A number without a declared model is marketing, not measurement.
- **Same custom model on both sides** when comparing the harness itself:
  zelari and the competitor run the same pinned provider/model, or the row
  is labeled incomparable and excluded from the summary.
- **Declared skips**: every skipped anchor/run carries a one-line reason
  (CLI absent / model undeclared / fixture failed). The skip rate is
  explained, never hidden — and the pass rate is not quoted outside
  `report.md`.
- **No numbers outside `report.md`**: published prose quotes the report
  verbatim or not at all. No partial numbers in README or release notes.

## Published snapshot convention

Each release appends one row per provider/model to the table below, produced
by `npm run eval:gate` (deterministic tier) — copy the summary block verbatim,
never hand-edit numbers:

| Release | Manifest | Provider/Model | Tier-0 anchors | Verdict | Cost/run |
|---|---|---|---|---|---|
| _run `npm run eval:gate` and paste here_ | | | | | |

> **No snapshot is published yet (checked 2026-09-05, post v2.30.0) — BLOCKED, not green.**
> The seeding runner (`tools/eval/runAnchors.ts`, headless) requires provider
> credentials (`ZELARI_API_KEY` / `ZELARI_LOCAL_CLI`) and refuses to fake
> outcomes; the publishing machine had none, so t51 stays **blocked**
> (unknown ≠ pass). To publish: run `runAnchors.ts --tier 0 --repeat 3` with
> credentials, then `npm run eval:gate`, and paste the summary verbatim above.
> The harness exists and runs in CI
> (retention gate); publishing the table per release is the follow-up tracked
> with the evolution engine rollout (ADR-0036): the same ledger that feeds
> the engine produces this table — the measurer stays outside the proposer.

## Anti-Goodhart rules

1. Tier-0 anchors are sealed: the evolution loop may **propose** new anchors,
   never edit sealed ones (enforced by `JUDGE_PATHS` in
   `scripts/verify-principles.mjs`).
2. Behavioral metrics accompany pass rate: a variant that raises pass rate
   while raising steer/interrupt rate or lowering average evidence tier is
   rejected.
3. A hold-out anchor quota rotates from anonymized real ledger tasks each
   release (planned; see ADR-0036 backlog).

## Sealed anchors (W2/t45, enforced)

Tier-0 anchors are content-frozen in eval/anchors/sealed.json; verify-principles recomputes every hash and fails the gate on drift. Hashes are computed over LF-normalized, BOM-stripped content (checkout-independent: sealing on Windows `core.autocrlf` and verifying on Linux CI yield the same digest — post-v2.30.0 fix). Manifest hash: `b16ca90360f9f634fcce07b4934b353b2d3a2ea7a471d56ca299585bd1adff1c`

Hold-out rotation quota: derive new-anchor candidates from anonymized ledger outcomes each release (npm run evolve:seal -- --rotation-candidates). Behavioural promote rule: npm run evolve:decide blocks applied on steer/tier regression by code.

## Extension/plugin capability baseline (t147)

The extension surface had NO recorded anchors, so `npm run eval:gate -- --candidate all` found no
manifest directories and exited 2. `npm run eval:extensions` closes that gap: it runs the suite
defined in `tools/eval/extensionAnchors.ts` and seeds `eval/results/<suite-hash>/` (`anchors.jsonl`
+ `summary.json`) through the shared `EvalResultStore` (`tools/eval/resultStore.ts`).

What the five checks EXECUTE — real capability code, no echo-stub runner anywhere on this path:

| anchor id | capability exercised |
| --- | --- |
| `ext-echo-tool-load` | `loadExtensionsFromDirs` dynamic-imports the shipped `examples/extensions/echo-tool/extension.js` from a temp fixture dir; the registered `echo_tool` executes and echoes its input |
| `ext-onpre-deny` | fixture extension `onPreToolUse('*', () => ({ deny: true, reason }))` through `withExtensionPreToolUse`: the call is denied with the typed `[extension-hook:<id>]` error AND the tool body provably never ran (marker file absent) |
| `ext-lifecycle-observer` | `createLifecycleHooksFromDirs` loads a hook JSON; `runPermissionRequest` SPAWNS the hook process, which records the structured payload (`event`, `permission.tool`, `sessionId`) |
| `plugin-bundle-contract` | `loadBundle` validates the shipped `examples/extensions/zelari-plugin-example` (1 skill + 1 observer hook + 1 mcp), contributes NOTHING while disabled, and REFUSES a manifest carrying an unknown key |
| `ext-loader-fail-closed` | a module that throws at import is skipped without aborting the batch; a strict `extensions.lock` sha256 mismatch returns the typed `ExtensionLockError` with nothing imported |

How to run it:

```bash
npm run eval:extensions                  # exit 0 iff every check passed; prints the suite hash
npm run eval:gate -- --baseline <hash> --candidate <hash>   # → COMMIT (self-comparison)
npx vitest run tools/eval/extensionAnchors.test.ts          # the 7 self-checks of the suite
```

Suite manifest hash (sha256 over the stable `(id, version)` list; a title edit does not move it,
adding/re-versioning a check does):

```
0755e7a2f45b40402b20dc23688d8fae8e40827939caf5a3a83ed994650058a4
```

Recorded run (2026-09-21T16:17:40.343Z, this working tree — the run whose `summary.json` is in
the store):

- checks: **5/5 passed**, 0 failed → `npm run eval:extensions` exit 0;
- wall time, measured: 106 ms total / 21 ms avg — per check 7 / 4 / 64 / 22 / 9 ms
  (`ext-lifecycle-observer` dominates: it spawns a real `node` hook process);
- store `eval/results/0755e7a2…/`: `anchors.jsonl` with exactly 5 records (one per check) +
  `summary.json` → `currentSuite {passed: 5, total: 5}`, `validity.passed: true`,
  `candidateRecords: 5`, `verifiedSolveRate: 1.00`, `cost.total.modelCostUsd: 0`, `wallMs: 106`,
  `wallMsPerVerifiedSolve: 21.2`;
- `npm run eval:gate -- --baseline 0755e7a2… --candidate 0755e7a2…` → **COMMIT** (0 regressions),
  the acceptance path for the baseline-vs-candidate comparison.

Honesty notes and limits (read before quoting these numbers):

- **Deterministic and offline**: no model, no network, no credentials, no clock-dependent
  assertion. `cost` is zero BY CONSTRUCTION — the only measured number is `wallMs`. These are
  capability anchors and are **NOT comparable** with the model-measured baselines from
  `npm run eval:seed-baseline`; `runSeedBaseline.ts` stays model-only.
- `resourcePolicyHash` is the sha256 of the fixed label `extension-baseline/offline-deterministic/v1`
  — not a resolved profile policy hash, because this suite runs under no profile.
- Re-running appends to the same `anchors.jsonl` (the store contract is append-only);
  `summary.json` is refreshed. `runGate` compares per `anchorId`, so repeated runs do not create
  regressions, but the file does grow.
- Expected, benign stderr on every run: `[hooks] hook "t147-permission-observer" returned
  invalid JSON (fail-closed):` — the fixture hook is an OBSERVER, whose decision is discarded by
  design; the check asserts the payload that did arrive.
- **ACP is out of scope for this baseline.** The VS Code ACP client is a pure Node layer
  (`apps/vscode/src/acpClient.ts` imports no `vscode` module, per its own header), so a
  protocol-level handshake anchor is feasible — but it was deliberately NOT wired into t147, whose
  acceptance target is the extension/plugin suite. Tracked as a follow-up.
- Runner caveat: `eval:extensions` runs under `node --experimental-transform-types` plus a tiny
  inline `.js`→`.ts` resolve hook, because `src/cli/extensions/loader.ts` uses a TS parameter
  property (strip-only mode rejects it) and Node does not rewrite `.js` specifiers to `.ts`. Vitest
  needs neither (Vite resolves those specifiers). Rationale is documented in the header of
  `tools/eval/runExtensionsBaseline.ts`.
- Runner-version floor: `--experimental-transform-types` needs Node ≥ 22.7 (the other
  `eval:*` scripts already require ≥ 22.6 for type stripping).

