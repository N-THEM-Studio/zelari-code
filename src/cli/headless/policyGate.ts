/**
 * policyGate — P0.B pre-flight for headless/mission dispatch.
 *
 * When the resolved policy-load mode is strict (headless, CI=1, zelari
 * missions; ZELARI_POLICY_LOAD_MODE wins), an existing but BROKEN policy
 * file must not just log a warning and silently drop every rule: the run
 * blocks BEFORE any provider call, tool registry build or agent turn with
 *
 *   - exit code 2 (the map's "runtime error": POLICY_LOAD_EXIT_CODE — exit 4
 *     stays owned by the strict COMPLETION gate),
 *   - a machine-readable teardown: NDJSON `error` event + stderr line with
 *     reason `policy-load-failed`, code `policy_invalid`,
 *   - on-disk evidence in the session spine (the same log other BLOCKED
 *     outcomes land in), written via the same host helpers.
 *
 * Permissive mode never reaches the blocking branch: the probe still runs
 * so warnings surface once on stderr, matching v1 behavior everywhere else.
 */
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isPolicyEngineDisabled,
  loadPolicySet,
  PolicyLoadError,
  type PolicyLoadMode,
} from '../safety/policyEngine.js';
import { POLICY_LOAD_BLOCK_REASON, POLICY_LOAD_EXIT_CODE } from '../safety/policyLoadMode.js';
import { emitEvent } from '../headless.js';

/** Machine-readable block payload attached to the teardown artifacts. */
export interface PolicyLoadBlock {
  /** Stable discriminator — hosts key automation off this. */
  reason: typeof POLICY_LOAD_BLOCK_REASON;
  /** Always POLICY_LOAD_EXIT_CODE (2); kept explicit for NDJSON/spine payloads. */
  exitCode: number;
  /** Why the file was rejected ('policy_invalid'). */
  code: PolicyLoadError['code'];
  /** Absolute path of the offending file (resolved against root). */
  file: string;
  /** Parser detail when available (JSON message / schema reason). */
  detail?: string;
}

export interface StrictPolicyLoadResult {
  blocked: boolean;
  /** Present only when blocked. */
  block?: PolicyLoadBlock;
  /** Non-fatal warnings (rule-level issues) — surfaced once, then ignored. */
  warnings: string[];
}

/**
 * Load-strictness probe for the runner pre-flight. Throws only on
 * unexpected loader bugs; PolicyLoadError is converted into a block.
 */
export function checkStrictPolicyLoad(
  root: string,
  opts: { homeDir?: string; mode: PolicyLoadMode },
): StrictPolicyLoadResult {
  if (isPolicyEngineDisabled()) return { blocked: false, warnings: [] };
  try {
    const set = loadPolicySet(root, opts);
    return { blocked: false, warnings: set.warnings };
  } catch (err) {
    if (!(err instanceof PolicyLoadError)) throw err;
    const file = isAbsolute(err.file) ? err.file : resolve(root, err.file);
    return {
      blocked: true,
      warnings: [],
      block: {
        reason: POLICY_LOAD_BLOCK_REASON,
        exitCode: POLICY_LOAD_EXIT_CODE,
        code: err.code,
        file,
        ...(err.message ? { detail: err.message } : {}),
      },
    };
  }
}

/**
 * Human + machine teardown chatter: one stderr line (plain mode has no
 * stdout JSON contract) and, in json mode, one fatal NDJSON error event
 * carrying `code: "policy-load-failed"` — the event hosts already render.
 */
export function reportPolicyLoadBlocked(block: PolicyLoadBlock, output: 'json' | 'plain'): void {
  const where = `${block.file}${block.detail ? ` — ${block.detail}` : ''}`;
  process.stderr.write(`[zelari-code --headless] ${block.reason}: ${where}\n`);
  if (output === 'json') {
    emitEvent({
      type: 'error',
      severity: 'fatal',
      message: `${block.reason}: ${where}`,
      code: block.reason,
    });
  }
}

/**
 * On-disk evidence: open (or resume) the session spine and record the BLOCK
 * outcome in the same log other blocked outcomes use, then close it as an
 * errored session. Missions additionally get their `mission.phase` marker,
 * mirroring mission-strict-blocked. Best-effort by contract — a spine
 * failure NEVER changes the exit path (degrade-and-stop like every host).
 */
export async function recordPolicyLoadBlockedOnSpine(
  block: PolicyLoadBlock,
  opts: { mode?: string; profile?: string; resumeSessionId?: string } = {},
): Promise<void> {
  try {
    const { openHeadlessSpine } = await import('../headlessSpine.js');
    const sessionId = opts.resumeSessionId ?? randomUUID();
    const spine = await openHeadlessSpine({
      sessionId,
      ...(opts.mode ? { mode: opts.mode as 'kraken' | 'council' | 'zelari' } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      workspace: process.cwd(),
    });
    if (opts.mode === 'zelari') {
      spine.missionPhase('dispatch', block.reason);
    }
    spine.note(block.reason, {
      code: block.code,
      file: block.file,
      exitCode: block.exitCode,
      ...(block.detail ? { detail: block.detail } : {}),
    });
    await spine.close('error');
  } catch {
    /* spine never fails the run */
  }
}
