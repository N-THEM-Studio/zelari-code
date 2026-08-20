# ADR-0027: Strict done for Kraken default (2.1 evaluation)

- **Status**: accepted
- **Date**: 2026-08-20
- **Deciders**: council (Lucifero chair), Kraken lead
- **Supersedes**: the Kraken half of ADR-0026 (mission stays strict-by-default)

## Context

ADR-0026 shipped 2.0.0 with strict completion **opt-in** for the Kraken
surface (`ZELARI_STRICT_DONE=1`) and ON-by-default for Mission. The stated
reason: turning strict on everywhere would change baseline cost/latency for
1.x-era tasks, and the 2.1 cycle should re-evaluate.

2.1 facts on the table (implemented in this cycle):

- The strict gate now also fires when only the native criteria pack is on
  (T6 — pack independence from `isKrakenSelectionEnabled()`).
- The advisory verifier review is opt-in via dedicated-model configuration
  or `ZELARI_VERIFIER_REVIEW` (T4) and never changes verdicts.
- Evidence anchoring is now original-tool-backed when a capture matches
  (T5), so strict PASS on selection criteria no longer depends on
  re-emitted agent notes in the common case.
- The automatic repair pass (budget = 1) already absorbs most
  first-gate blocks in practice.

Remaining cost driver: on turns with **no selection and no pack**, strict
evaluation has nothing to evaluate — zero overhead. The only real cost
delta is when the pack runs real commands (`typecheck`/`test`/`build`),
which is exactly the cost a user opting into verification expects.

## Decision

1. **Kraken strict stays opt-in for selection-based gating** in 2.1
   (`ZELARI_STRICT_DONE`), same as 2.0. Rationale: required checks exist
   only on selection turns; forcing strict there without selection running
   is a no-op anyway. No behavior change needed.
2. **The native criteria pack becomes the lightweight strict default
   candidate**, evaluated per-repo: if the workspace binds `test` (or
   `typecheck`), `ZELARI_VERIFY_PACK` semantics MAY be auto-enabled by the
   host (Desktop) preference — the CLI keeps the env explicit so CI and
   scripts stay deterministic. See ADR-0028 for the adaptive policy.
3. Mission strict-by-default is unchanged (ADR-0025).
4. Revisit trigger for flipping the Kraken default: one minor cycle of
   telemetry on `verification.run` events showing repair-pass success rate
   ≥ 70% and no latency regression beyond +1 pack run.

## Consequences

- No baseline cost change for default Kraken turns in 2.1.
- Hosts can offer "verify on build" as a first-class toggle backed by the
  pack, without touching selection.
- The `done = evidence` philosophy becomes opt-out at the host level
  rather than opt-in at the env level, without breaking CLI determinism.

## Alternatives considered

- **Strict ON for every Kraken BUILD turn**: rejected — turns without
  selection criteria and without a pack-bound repo produce nothing
  verifiable; blocking them adds cost without adding guarantees.
- **Keep everything opt-in indefinitely**: rejected — the 2.0 review
  (`statoattuale.md`) flagged "runtime evidence-driven, Kraken default not
  yet" as the main 2.1 gap; the pack-adaptive path closes it without the
  cost blowup.
