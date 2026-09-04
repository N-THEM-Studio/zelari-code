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
