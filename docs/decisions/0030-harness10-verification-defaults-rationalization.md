# ADR-0030 - HARNESS-10 defaults rationalization: strict-done and verify-pack ON, headless trust UNTRUSTED

**Status:** Accepted
**Date:** 2026-08-23
**Rationalizes (does not rewrite):** [ADR-0025](0025-strict-done-defaults.md), [ADR-0026](0026-rc-defaults-event-backed-and-strict.md), [ADR-0027](0027-strict-kraken-default-2-1.md)
**Context:** HARNESS-10 plan, section 6 (verificationBridge) - items 6.4, 6.5, 6.7

## Context

ADR-0025 -> 0027 tell the evolution of verification defaults per surface: mission strict-ON from the start (0025), evidence event-backed ON at RC (0026), Kraken **opt-in** with the native pack as default candidate (0027), adaptive pack with host-delegated default (0028).

The HARNESS-10 hardening cycle (2.15+) however **put into code** what those ADRs left as an option or a future promise:

1. **P0.1 - strict done default ON also for Kraken.** `strictDoneEnabled()` in `src/cli/kraken/verificationBridge.ts` returns `true` without env; `ZELARI_STRICT_DONE=0|false` is the only opt-out (lock test: `strictDefaults.test.ts`).
2. **P0.2 - native criteria pack default ON.** `nativePackEnabled()` in `src/cli/kraken/nativeVerification.ts` returns `true` without env; the headless BUILD gate opens with `(selection || nativePackEnabled())` (`runHeadless.ts`) and `ZELARI_VERIFY_PACK=0|off|false` is the only opt-out (lock tests: `nativeVerification.test.ts`, `headless-verify-pack-default.test.ts`).
3. **6.7 - headless trust: UNTRUSTED default (unchanged).** An untrusted folder loads neither project hooks (`.zelari/hooks/`) nor project MCP (`.zelari/mcp.json`); `zelari-code --trust` (`trustFolder()`, main.ts) or `ZELARI_FOLDER_TRUST` enable explicitly (lock test: `headless-folder-trust.test.ts`).
4. **6.6 - residual hygiene (t31):** post-execute diagnostics on source paths claimed by bash/exec_process, same engine and same channel (`value.diagnostics`) as the post-edit loop; item 6.4 limited to verification coverage on the headless BUILD surface.

The old ADRs are immutable by policy ("every decision is immutable once accepted; changes happen by writing a new ADR"): they remain the faithful historical record of the opt-in era, but **no longer describe the product's behavior** on Kraken defaults.

## Decision

**Code wins: the current defaults are the product decision.**

1. **Kraken: strict-done ON and verify-pack ON remain the defaults.** The code is not realigned to ADR-0025/0026/0027; the documents are realigned to this ADR, which marks those three ADRs as *partially superseded* on the single question of the Kraken default. The rationale of the time (1.x baseline cost, smoke matrix) was superseded by HARNESS-10 facts: the automatic repair pass (budget = 1) absorbs the majority of blocks, evidence anchoring is tool-backed (T5) and the pack is repo-adaptive - a repo without deterministic commands receives no impossible blockers.
2. **The opt-outs stay identical and documented** - no narrowing: `ZELARI_STRICT_DONE=0|false` (kraken), `ZELARI_MISSION_STRICT=0|false` (mission), `ZELARI_VERIFY_PACK=0|off|false` (pack). The CLI flags `--no-strict-done` and the explicit-on variants remain.
3. **6.7: the untrusted default does NOT change.** It is the only point where HARNESS-10 *confirms* pre-existing behavior: running project-scoped code (hooks/MCP) requires an explicit act of trust. This is security-by-default, not a default to revisit.
4. **Mandatory verification coverage** on the three points (already in suite): pack default ON on headless BUILD, explicit opt-out, untrusted default with `--trust` enabling.

## Alternatives considered

1. **Rewrite ADR-0025/0026/0027** - rejected: violates the directory's immutability policy and would erase the decision trail (why the default was opt-in, and what changed it).
2. **Revert the code to opt-in** - rejected: a regression of the false-done guard exactly where the hardening closed it; the opt-outs already exist for those who want them.
3. **Trusted default in headless for "CI convenience"** - rejected: it loads code from the repo without explicit consent; `ZELARI_FOLDER_TRUST=1` remains the documented escape hatch for trusted CI.

## Consequences

**Positive** - a single point of truth for the defaults (this ADR); the lock tests make the defaults a verifiable contract; the historical ADRs remain intact as a record.

**Negative** - anyone who read only ADR-0025 -> 0027 expects opt-in: the mitigation is the cross-link (here -> them, and the README index) and the unchanged opt-outs.

## TODO

- [x] 6.5: strict-done default ON lock test (`strictDefaults.test.ts`)
- [x] 6.4: headless BUILD pack default ON / off-with-env coverage
      (`headless-verify-pack-default.test.ts`, `nativeVerification.test.ts`)
- [x] 6.7: headless trust regression test (`headless-folder-trust.test.ts`)
- [x] 6.6 (t31): post-execute diagnostics on claimed source paths
      (`cli-execDiagnostics.test.ts`)
- [x] README index updated with this ADR