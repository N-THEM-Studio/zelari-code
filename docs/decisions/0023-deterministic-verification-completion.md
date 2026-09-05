# ADR-0023 - Deterministic verification and CompletionPolicy (evidence contract)

**Status:** Accepted
**Date:** 2026-08-19

## Context

The Kraken 1.49 completion gate (`src/cli/kraken/completionGate.ts`, ADR-0020) already applies `unknown != pass` with a repair pass, but it is typed on the tentacle's verify report, not on a general contract. The 2.0 plan wants: simple tasks verifiable without an LLM, evidence traceable to the original tool output, measurable false-done.

## Decision

`@zelari/core/verification` introduces the evidence contract:

- **`Criterion`** `{id, text, source: task|plan|kraken-selection|mission|criteria-pack, required, check?}` where `check` is a deterministic discriminated union: `command` (expectExit/expectStdoutIncludes/timeout), `file-exists`, `file-contains`, `file-absent`, `none`.
- **`EvidenceRef`** `{seq?, tier: tool-output|command-output|fs-observation|verifier-llm|human, ref, capturedAt, digest?}` - the digest is the sha256 of the output; `seq` links back to the original spine event when it exists.
- **`VerificationResult`** `{criterionId, status: pass|fail|unknown, source, evidence[], evaluatedAt, durationMs, detail?}`. **`unknown != pass` everywhere**: no coercion.
- **`VerificationEngine.evaluate`** - deterministic, zero LLM: runs the checks via ShellProvider/FsProvider and builds the evidence with digest. Missing check or missing provider -> `unknown` with reason, never `pass`.
- **`CompletionPolicy`** (strict) -> `PASS | REPAIR_REQUIRED | BLOCKED`:
  - missing required or `unknown` (including "pass without evidence") -> non-PASS;
  - `fail` present -> `REPAIR_REQUIRED`; only unknown/missing -> `BLOCKED`
    ("clean done without sufficient evidence can be blocked");
  - `strictBuildGate` is the alias for the BUILD/mission gate (`ZELARI_STRICT_DONE=1`
    initially, default in beta).
- **Criteria Pack v1** (`zelari-coding/v1`): correctness.specification (test), correctness.observable-output (build), correctness.error-signals (typecheck), quality.scope-discipline, evidence.verification-quality (required: false).
- **Metrics**: `computeFalseDoneRate` / `verifiedSolveRate` / `verificationCostRatio`.
- **VerifierService (3B, alpha) is advisory**: its verdict/score NEVER enters the `CompletionPolicy` - no done based only on the score, no P2 bypass. The effective model (inherit|fixed) is always logged in the verification event.

## Alternatives considered

1. **Extend only the CLI `completionGate`** - rejected: the gate would stay tied to the verify tentacle and not reusable for mission/headless/Desktop.
2. **LLM-verifier-only verification** - rejected: violates "simple tasks verifiable without an LLM" and makes the cost of simple tasks non-baseline.

## Consequences

**Positive** - false-done measurable and reduced by construction; auditable evidence (VerificationResult -> EvidenceRef -> event -> tool output); CLI 1.x keeps working (the 3A.6 adapter maps existing verify reports onto `VerificationResult`).

**Negative** - initial rigor: criteria without a deterministic check surface as `unknown` (deliberately honest); the pack must be wired to the repo's real commands.