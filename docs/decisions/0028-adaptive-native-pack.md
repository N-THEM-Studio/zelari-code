# ADR-0028: Adaptive native criteria pack (2.1 evaluation)

- **Status**: accepted
- **Date**: 2026-08-20
- **Deciders**: council (Lucifero chair), Kraken lead

## Context

`ZELARI_VERIFY_PACK=1` (2.0) evaluates the Zelari Coding Criteria Pack on
BUILD turns, but it is fully manual. The 2.0 review identified the pack as
"repo-adaptive" already — required criteria without a bound command are
dropped, so a repo without `build` never gets an impossible criterion.

T6 (this cycle) made the pack independent from Kraken selection: the gate
fires on `(selectionUsed || packEnabled)`. The remaining question is when
the pack should turn itself on.

## Decision

1. **CLI stays explicit**: the pack activates only via `ZELARI_VERIFY_PACK`
   (or `1|true` variants) or an explicit `--verify-pack` flag. Scripts and
   CI keep deterministic behavior. No implicit env-less activation in the
   CLI for 2.1.
2. **Adaptive default belongs to the host**: the Desktop may default the
   preference ON when the workspace's `package.json` binds `test` or
   `typecheck` scripts (cheap, deterministic signals), and surface it as a
   visible toggle. The host passes the flag explicitly per run.
3. **Repo-adaptive shaping is already the contract**: `buildNativeCriteria`
   drops required-but-unbound criteria; a repo binding only `test` gets
   exactly the `test` criterion as required. Nothing-bound ⇒ no pack
   evaluation, no fake unknown blockers.
4. Cost guard: the pack runs at most once per gate evaluation (turn +
   optional repair pass ⇒ at most twice), with the existing
   `ZELARI_VERIFY_TIMEOUT` per-command cap.

## Consequences

- Deterministic CLI, opinionated-but-reversible host default.
- "done = evidence" becomes the normal Desktop experience for repos with
  real test scripts, with zero config.
- If the host default proves too costly, flipping the preference off is a
  UI action — no release needed.

## Alternatives considered

- **Auto-enable in the CLI when scripts exist**: rejected — implicit
  behavior changes in `npm run` style workflows and CI would be surprising
  and hard to debug; the env flag is one line for anyone who wants it.
- **Enable only `typecheck` (cheapest) by default**: deferred — worth
  evaluating with telemetry once the host default ships.
