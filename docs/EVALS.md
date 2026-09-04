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

## Published snapshot convention

Each release appends one row per provider/model to the table below, produced
by `npm run eval:gate` (deterministic tier) — copy the summary block verbatim,
never hand-edit numbers:

| Release | Manifest | Provider/Model | Tier-0 anchors | Verdict | Cost/run |
|---|---|---|---|---|---|
| _run `npm run eval:gate` and paste here_ | | | | | |

> **No snapshot is published yet.** The harness exists and runs in CI
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
