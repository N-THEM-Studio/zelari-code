# ADR-0025 - Strict done defaults per surface

**Status:** Accepted
**Date:** 2026-08-20

## Context

ADR-0023 introduced the strict BUILD gate (`PASS | REPAIR_REQUIRED | BLOCKED`, `unknown != pass`, dedicated exit 4) activated by `ZELARI_STRICT_DONE=1` - default **off** "initially, default in beta". The open question was which default to freeze for the two surfaces that close work:

- **Kraken** (headless `--task` / TUI / Desktop): interactive or single-task turns, the user is present and can react to the verdict.
- **Mission** (`--mode zelari`, profile `mission/v1`): a multi-iteration autonomous loop with no user at the wheel; an unverified "success" is consumed by host/automation without supervision.

A single default for both surfaces is wrong in both directions: strict-ON by default in Kraken breaks 1.x compatibility of simple tasks, violating the baseline-cost principle; strict-OFF by default in missions allows false-done exactly where nobody can intercept it.

## Decision

**Defaults split per surface** (Option A of the alpha.6 status document, section 7):

1. **Kraken interactive/headless: strict = opt-in.** `ZELARI_STRICT_DONE=1|true` or `--strict-done` activate the gate; default stays **off** until RC (then re-evaluated with the profile smoke matrix, ADR-0023 "default in beta").
2. **Mission: strict evidence gate = default ON.** The mission closes under the gate without requiring a flag; explicit deactivation with `ZELARI_MISSION_STRICT=0|false` (documented escape hatch, not encouraged).

Composition rules (already implemented by ADR-0023 and lock test F1):

- the mission gate **sums** blockers (legacy + evidence contract + native pack);
- the deterministic verdict is never rewritten by the LLM verifier (advisory);
- gate blocked on a mission "success" -> exit code 4 and `missionPhase('verification', 'mission-strict-blocked')` on the spine, not 0.

Safety guards:

- the native pack (`ZELARI_VERIFY_PACK`) stays a **separate opt-in** on both surfaces: the mission-ON default activates the selection-contract gate, **not** the automatic execution of typecheck/test/build;
- a mission without registered required checks -> vacuous gate, unchanged behavior (no new failures on missions without selection).

## Alternatives considered

1. **Strict-ON everywhere (Option B "deterministic verification default")** - rejected for now: it breaks Kraken's 1.x compatibility before the profile smoke matrix (Exit-3.2) proves the baseline cost of simple tasks does not regress. To be re-evaluated at RC.
2. **Strict-OFF everywhere until beta** - rejected: missions are the place with the highest false-done risk and the least human oversight.
3. **A single global knob** (`ZELARI_STRICT_DONE` for everything) - rejected: the default semantics IS the decision; a single knob cannot express "opt-in here, opt-out there" and would make verifying mission behavior in CI impossible without polluting Kraken.

## Consequences

**Positive** - false-done is blocked by construction exactly where there is no supervision; Kraken keeps the 1.x baseline cost; the defaults are testable as a contract (`strictDefaults.test.ts`) and individually reversible at RC.

**Negative** - two env vars to document (`ZELARI_STRICT_DONE`, `ZELARI_MISSION_STRICT`); a mission with a red verification now exits 4 where it used to exit 0 (breaking for automation parsing the exit code - mitigated by the escape hatch and the `mission-strict-blocked` spine message).

## TODO

- [x] `strictDoneEnabled(surface)` mode-aware in `verificationBridge.ts`
- [x] Mission gate at wind-down in `runHeadless.ts` (exit 4 + spine event)
- [x] `--strict-done` help updated with the mission default
- [x] Defaults lock test (`strictDefaults.test.ts`)
- [x] RC: re-evaluate the Kraken default - **stays opt-in** (ADR-0026)
- [x] RC: `requireEventBackedEvidence` ON in `STRICT_BUILD_POLICY` (ADR-0026)