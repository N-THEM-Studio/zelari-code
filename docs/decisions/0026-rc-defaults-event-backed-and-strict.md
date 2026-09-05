# ADR-0026 - RC defaults: evidence event-backed ON, Kraken strict stays opt-in

**Status:** Accepted
**Date:** 2026-08-20
**Partially supersedes:** the "re-evaluate at RC" TODOs of [ADR-0025](0025-strict-done-defaults.md)

## Context

Alpha.8 closed Exit-2 and Exit-3. Before leaving alpha, three explicit decisions remained:

1. Turn on `requireEventBackedEvidence` in `STRICT_BUILD_POLICY`.
2. Re-evaluate the Kraken strict default (ADR-0025 left it opt-in until RC).
3. Publish `2.0.0` (no longer `2.0.0-alpha.x`).

The profile smoke matrix (Exit-3.2) proves profiles load and that plan strips mutators. It does **not** measure the baseline cost of running typecheck/test/build on every interactive Kraken task, nor how often a 1.x turn closes only with verify-tentacle notes.

## Decision

1. **`STRICT_BUILD_POLICY.requireEventBackedEvidence = true` from 2.0.0.**
   A `pass` with only a note (tier `tool-output` / `command-output` / `fs-observation` without `EvidenceRef.seq`) is **BLOCKED**.
   Explicit opt-out: `{ ...STRICT_BUILD_POLICY, requireEventBackedEvidence: false }`.
2. **Kraken stays opt-in** (`ZELARI_STRICT_DONE=1` / `--strict-done`).
   Turning strict on by default for Kraken, *with* the event-backed flag ON, would make every interactive task whose only evidence is verify-tentacle notes **without** a spine emitter exit **exit 4**. The production path (`runHeadless` / TUI) already passes `emit` and still anchors the notes (`anchorSelectionEvidence`); tests and callers without an emitter must either inject `emit` or accept BLOCKED. That is the contract, not a silent default over the whole 1.x CLI.
3. **Mission stays default ON** (ADR-0025 unchanged). The native pack (`ZELARI_VERIFY_PACK`) stays opt-in on both surfaces.
4. The product leaves alpha: version **`2.0.0`**.

## Alternatives considered

1. **Kraken strict ON everywhere (Option B of the alpha.6 document)** - rejected for 2.0.0: it breaks the 1.x baseline cost of simple tasks (every `--task` without registered checks stays open, but every task with selection + unanchored notes becomes exit 4). To be re-evaluated in 2.1 when the native pack is the default path *and* every host passes `emit`.
2. **Keep `requireEventBackedEvidence` OFF** - rejected: it is the anti-false-done gate that sections 5/19 asked for before RC.
3. **Publish `2.0.0-rc.1` instead of `2.0.0`** - rejected on explicit product request ("publish version 2").

## Consequences

**Positive** - the evidence -> completion circuit is native *and* demanding: no "done" on a verify-agent string without a session event.

**Negative** - breaking for anyone evaluating `STRICT_BUILD_POLICY` as a library with unanchored evidence (previously PASS, now BLOCKED). Mitigation: explicit opt-out on the policy object; CLI callers with `emit` do not change verdict.

## TODO

- [x] `requireEventBackedEvidence: true` in `STRICT_BUILD_POLICY`
- [x] `anchorSelectionEvidence()` in the bridge (notes -> `verification.evidence`)
- [x] Tests: default ON blocks unanchored; emit anchors and PASSes
- [x] ADR-0025 RC TODOs checked off / pointed here
- [x] Lockstep bump `2.0.0`