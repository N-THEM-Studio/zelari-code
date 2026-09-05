# ADR-0010: First principles manifesto (PRINCIPLES.md)

- **Status:** Accepted
- **Date:** 2026-08-13
- **Deciders:** Andrea (governance session)
- **Related:** ADR-0009 (Apache-2.0 license), ADR-0007 (pre-release audit), ADR-0004 (API stability)

## Context

The project's principles were scattered across `AGENTS.MD` (conventions),
ADRs, `.zelari/docs/` and runtime policy, with no criterion to distinguish
a *first principle* from a *convention*, nor to say what was mechanically
guaranteed. The governance session applied three tests (arbitrates a
tradeoff / stable across versions / not derivable) and produced a
canonical set.

## Decision

1. **`PRINCIPLES.md`** is the canonical manifesto; in case of conflict it
   wins over `AGENTS.MD` and docs.
2. The six first principles: **P1 Verifiability**, **P2 Determinism of
   control**, **P3 User sovereignty**, **P4 Open and reusable runtime**
   (Apache-2.0), **P5 Lightness**, **P6 The right orchestration for the
   job**.
3. Specific decisions of the session:
   - The identity principle is **the right orchestration for the job**
     (P6): the kraken default violates no principle; council and zelari
     are instances.
   - **Apache-2.0 license** on the whole product (ADR-0009); secrecy
     policy reformulated as "open runtime, protected experience".
   - **P5 comes first** with corrected wording: explicit exemption for
     the interface (Ink+React in the CLI, Tauri in Desktop).
   - **P3 on shared domains**: goals to the user, dangerous means to the
     system, mandatory transparency.
   - Previous conventions (Zod for tool args, <=300 LOC, atomic commits,
     async-first, ...) are **derivations** of P1/P2/P5, listed in
     `PRINCIPLES.md`.
4. Guarantee classification per principle (deterministic / semi /
   aspirational) and roadmap: `scripts/verify-principles.mjs` + CI on
   `pull_request` to make P5 and its derivations mechanical gates.

## Consequences

- New decisions must be motivated against the first principles.
- "Zod / <=300 LOC / no-heavy-deps" remain operational constraints but
  **derived**: violating them does not violate a first principle, except
  when they break P1/P2/P5.
- ADR-0008 superseded by ADR-0009; docs and CHANGELOG updated.