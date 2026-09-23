/**
 * ssh/remoteJobPlan.ts — anti-tamper plan for remote job execution.
 *
 * Implements the unreal-agent pattern: a `RemoteJobPlan{Type, Version, Data}`
 * is sealed with a checksum before dispatch. The remote endpoint (or local
 * executor) verifies integrity + constraints before running. Mutation after
 * sealing is detected and rejected with a structured error.
 *
 * The plan is a LOCAL abstraction — the SSH target doesn't need to understand
 * it. Constraints are enforced by the caller before `runSsh()`.
 *
 * @see .zelari/docs/2026-09-21-piano-roi-steal-unreal-agent.md §B6
 */

import { createHash } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────────

export interface RemoteJobPlan {
  /** What kind of job this is (e.g. 'deploy', 'build', 'status', 'custom'). */
  readonly type: string;
  /** Schema version of the plan format. */
  readonly version: number;
  /** The actual payload (command string, structured data, etc.). */
  readonly data: Record<string, unknown>;
  /** Max bytes of stdout/stderr the remote may return. 0 = no limit. */
  readonly maxOutputBytes: number;
  /** HMAC-SHA256 over canonical(type, version, data, maxOutputBytes). */
  readonly seal: string;
}

export interface RemoteJobPlanInput {
  type: string;
  version?: number;
  data?: Record<string, unknown>;
  maxOutputBytes?: number;
}

export type PlanVerificationResult =
  | { ok: true; plan: RemoteJobPlan }
  | { ok: false; error: string; code: PlanRejectionCode };

export type PlanRejectionCode =
  | 'seal_mismatch'
  | 'invalid_type'
  | 'invalid_version'
  | 'missing_seal'
  | 'constraint_violated';

// ── Canonical serialization ─────────────────────────────────────────────

/**
 * Deterministic JSON serialization for checksum computation.
 * Keys sorted alphabetically, no whitespace. This is NOT the display format
 * — it exists solely for seal computation.
 */
function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalize).join(',')}]`;
  }
  if (typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>).sort();
    const entries = sorted.map(
      (k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return String(obj);
}

// ── Seal computation ────────────────────────────────────────────────────

const SEAL_SECRET = 'zelari-remote-job-plan-v1';

function computeSeal(
  type: string,
  version: number,
  data: Record<string, unknown>,
  maxOutputBytes: number,
): string {
  const payload = canonicalize({ type, version, data, maxOutputBytes });
  return createHash('sha256')
    .update(`${SEAL_SECRET}:${payload}`)
    .digest('hex');
}

// ── Plan creation ───────────────────────────────────────────────────────

/**
 * Create and seal a remote job plan. The returned plan is immutable and
 * carries a checksum that detects any post-creation mutation.
 */
export function createPlan(input: RemoteJobPlanInput): RemoteJobPlan {
  const type = input.type.trim();
  const version = input.version ?? 1;
  const data = input.data ?? {};
  const maxOutputBytes = input.maxOutputBytes ?? 0;
  const seal = computeSeal(type, version, data, maxOutputBytes);
  return Object.freeze({ type, version, data, maxOutputBytes, seal });
}

// ── Plan verification ───────────────────────────────────────────────────

/**
 * Verify a plan's integrity and constraints. Returns the plan if valid,
 * or a structured rejection with error code.
 *
 * Checks:
 * 1. `type` is a non-empty string
 * 2. `version` is a positive integer
 * 3. `seal` matches the recomputed checksum (tamper detection)
 * 4. Optional: caller can check additional constraints post-verification
 */
export function verifyPlan(plan: unknown): PlanVerificationResult {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: 'Plan must be an object', code: 'invalid_type' };
  }
  const p = plan as Record<string, unknown>;

  if (typeof p.type !== 'string' || !p.type.trim()) {
    return { ok: false, error: 'Plan.type must be a non-empty string', code: 'invalid_type' };
  }
  if (typeof p.version !== 'number' || p.version < 1 || !Number.isInteger(p.version)) {
    return { ok: false, error: 'Plan.version must be a positive integer', code: 'invalid_version' };
  }
  if (typeof p.seal !== 'string' || !p.seal) {
    return { ok: false, error: 'Plan.seal is missing — plan was not sealed', code: 'missing_seal' };
  }
  const data = (typeof p.data === 'object' && p.data !== null ? p.data : {}) as Record<string, unknown>;
  const maxOutputBytes = typeof p.maxOutputBytes === 'number' ? p.maxOutputBytes : 0;

  const expected = computeSeal(p.type.trim(), p.version, data, maxOutputBytes);
  if (p.seal !== expected) {
    return {
      ok: false,
      error: 'Plan seal mismatch — plan was mutated after sealing',
      code: 'seal_mismatch',
    };
  }

  return {
    ok: true,
    plan: Object.freeze({
      type: p.type.trim(),
      version: p.version,
      data,
      maxOutputBytes,
      seal: p.seal,
    }),
  };
}

// ── Constraint checking ─────────────────────────────────────────────────

/**
 * Check if a plan's constraints are satisfied. Called after verifyPlan
 * and before execution.
 *
 * @param plan - a verified plan
 * @param actualOutputBytes - the output size after execution (for post-run check)
 * @param allowedTypes - optional whitelist of plan types (empty = all allowed)
 */
export function checkPlanConstraints(
  plan: RemoteJobPlan,
  opts?: { actualOutputBytes?: number; allowedTypes?: string[] },
): { ok: true } | { ok: false; error: string; code: PlanRejectionCode } {
  if (opts?.allowedTypes && opts.allowedTypes.length > 0) {
    if (!opts.allowedTypes.includes(plan.type)) {
      return {
        ok: false,
        error: `Plan type "${plan.type}" not in allowed types: ${opts.allowedTypes.join(', ')}`,
        code: 'constraint_violated',
      };
    }
  }
  if (plan.maxOutputBytes > 0 && opts?.actualOutputBytes !== undefined) {
    if (opts.actualOutputBytes > plan.maxOutputBytes) {
      return {
        ok: false,
        error: `Output ${opts.actualOutputBytes} bytes exceeds plan limit of ${plan.maxOutputBytes} bytes`,
        code: 'constraint_violated',
      };
    }
  }
  return { ok: true };
}
