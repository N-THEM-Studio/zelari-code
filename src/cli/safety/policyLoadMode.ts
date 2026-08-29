/**
 * policyLoadMode — P0.B: where the strict/permissive file-loading default
 * comes from, and who wins.
 *
 * Precedence (highest first):
 *   1. ZELARI_POLICY_LOAD_MODE=strict|permissive (explicit env override)
 *   2. Surface defaults: headless runs, CI (CI=1) and zelari missions are
 *      STRICT; the interactive TUI stays PERMISSIVE (a typo in a personal
 *      policy.json must not brick a chat session).
 *
 * The resolver is PURE — every input is passed in, so tests never mutate
 * process.env. `activePolicyLoadMode()` is the one process-wide wrapper that
 * reads env + the active surface registered by the host (runHeadless calls
 * setActivePolicyLoadSurface before any registry exists; TUI never does and
 * keeps the 'tui' default).
 *
 * v2.16 (HARNESS-10 t22): strict ALSO implies lifecycle-hook FAIL-CLOSED —
 * in headless/mission/CI runs a hook that crashes, times out or returns
 * garbage DENIES the tool call (reason 'hook-failed') instead of allowing
 * it; the permissive TUI keeps fail-open allow+log.
 * `ZELARI_HOOKS_FAILURE=fail-open|fail-closed` can override (see
 * safety/lifecycleHooks.resolveHookFailureMode).
 */
import type { PolicyLoadMode } from './policyEngine.js';

/** Host that is about to load/evaluate policies. */
export type PolicyLoadSurface = 'headless' | 'mission' | 'tui';

/** Env override accepted by resolvePolicyLoadMode. */
export const POLICY_LOAD_MODE_ENV = 'ZELARI_POLICY_LOAD_MODE';

/** Machine-readable teardown reason for a blocked run (headless NDJSON + spine). */
export const POLICY_LOAD_BLOCK_REASON = 'policy-load-failed';

/**
 * Exit code for a strict load failure. Deliberately 2 — the existing
 * headless map already labels 2 as "runtime error" (provider failure,
 * council exception): an unreadable policy is exactly that class of
 * harness-level failure. Exit 4 stays reserved for the strict COMPLETION
 * gate (verificationBridge.STRICT_DONE_EXIT_CODE) so the two never collide.
 */
export const POLICY_LOAD_EXIT_CODE = 2;

export interface ResolvePolicyLoadModeInput {
  /** Which host is loading policies (drives the default). */
  surface: PolicyLoadSurface;
  /** Raw ZELARI_POLICY_LOAD_MODE value (undefined/unset = no override). */
  override?: string | undefined;
  /** Raw CI env value (undefined = unset). Truthy-flags: 1/true/yes/on. */
  ci?: string | undefined;
}

function isTruthyFlag(v: string | undefined): boolean {
  const n = v?.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}

/**
 * Pure mode resolution. Any value of ZELARI_POLICY_LOAD_MODE other than
 * exactly `strict` / `permissive` (case/space-insensitive) is IGNORED and
 * falls through to the defaults — no typo silently flips strictness.
 */
export function resolvePolicyLoadMode(input: ResolvePolicyLoadModeInput): PolicyLoadMode {
  const v = input.override?.trim().toLowerCase();
  if (v === 'strict') return 'strict';
  if (v === 'permissive') return 'permissive';
  // Headless runners and missions get fail-closed file loading by default;
  // interactive TUI only tightens when the ambient environment says CI.
  if (input.surface === 'headless' || input.surface === 'mission') return 'strict';
  if (isTruthyFlag(input.ci)) return 'strict';
  return 'permissive';
}

// ── Active-surface seam ──────────────────────────────────────────────────
// Process-lifetime configuration (hosts register once before dispatch);
// defaults to 'tui' because that is what imports toolRegistry directly.

let activeSurface: PolicyLoadSurface = 'tui';

/** Register the host BEFORE building registries (runHeadless pre-flight). */
export function setActivePolicyLoadSurface(surface: PolicyLoadSurface): void {
  activeSurface = surface;
}

/** Current host registration (read-mostly; exposed for tests/diagnostics). */
export function activePolicyLoadSurface(): PolicyLoadSurface {
  return activeSurface;
}

/**
 * Resolve the ACTIVE policy-load mode from the registered surface + env.
 * `env` is injectable so callers/tests avoid touching process.env.
 */
export function activePolicyLoadMode(env: NodeJS.ProcessEnv = process.env): PolicyLoadMode {
  return resolvePolicyLoadMode({
    surface: activeSurface,
    override: env[POLICY_LOAD_MODE_ENV],
    ci: typeof env.CI === 'string' ? env.CI : undefined,
  });
}
