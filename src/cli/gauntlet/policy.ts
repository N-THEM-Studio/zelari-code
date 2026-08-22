/**
 * Gauntlet policy — caps and enablement. Host-enforced (P2): these are not
 * prompt promises. Override via env; Desktop forwards --gauntlet.
 */
export const DEFAULT_MAX_PIECES = 6;
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_MAX_PARALLEL = 2;
/** Host-loop wall clock. 0 disables. Override ZELARI_GAUNTLET_WALL_MS. */
export const DEFAULT_WALL_MS = 45 * 60 * 1000;

/** Mutators the gauntlet parent (conductor) must not expose. */
export const GAUNTLET_PARENT_BLOCKED_TOOLS = [
  'write_file',
  'edit_file',
  'apply_diff',
  'bash',
] as const;

export interface GauntletCaps {
  maxPieces: number;
  maxRounds: number;
  maxParallel: number;
  /** 0 = disabled. Omit to use DEFAULT_WALL_MS. */
  wallClockMs?: number;
}

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isGauntletFlagOn(
  explicit?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw = env.ZELARI_GAUNTLET;
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function resolveGauntletCaps(env: NodeJS.ProcessEnv = process.env): GauntletCaps {
  const wallRaw = env.ZELARI_GAUNTLET_WALL_MS;
  let wallClockMs = DEFAULT_WALL_MS;
  if (wallRaw !== undefined && wallRaw !== '') {
    const n = Number.parseInt(wallRaw, 10);
    if (Number.isFinite(n) && n >= 0) wallClockMs = n;
  }
  return {
    maxPieces: envInt(env.ZELARI_GAUNTLET_MAX_PIECES, DEFAULT_MAX_PIECES, 1, 16),
    maxRounds: envInt(env.ZELARI_GAUNTLET_MAX_ROUNDS, DEFAULT_MAX_ROUNDS, 1, 8),
    maxParallel: envInt(env.ZELARI_GAUNTLET_MAX_PARALLEL, DEFAULT_MAX_PARALLEL, 1, 4),
    wallClockMs,
  };
}

/** True when the headless single-agent BUILD path should run the host loop. */
export function shouldRunGauntletHostLoop(opts: {
  gauntlet?: boolean;
  krakenGraph?: string;
  mode?: string;
  phase?: string;
  useCouncil?: boolean;
}): boolean {
  if (!isGauntletFlagOn(opts.gauntlet)) return false;
  if (opts.krakenGraph) return false;
  if (opts.useCouncil || opts.mode === 'council' || opts.mode === 'zelari') return false;
  const phase = opts.phase ?? 'build';
  return phase !== 'plan';
}

/**
 * 2.6 Track B (doc section 13.5): budget-aware gauntlet gate — combines the
 * critic verdict (PASS/GAP/BLOCKED, authority unchanged) with the resource
 * budget to decide how the REMAINING budget is spent. The critic and the
 * CompletionPolicy keep their authority; this only shapes next-action
 * feasibility. Pure function (unit-tested in tools/eval).
 */
export type GauntletBudgetDecision = 'proceed' | 'finalize-verify' | 'hold';

export function budgetAwareGauntletGate(input: {
  verdict: 'PASS' | 'GAP' | 'BLOCKED';
  toolCallsRemaining: number;
  verificationReserve: number;
}): GauntletBudgetDecision {
  if (input.verdict === 'PASS') return 'proceed';
  // 2.6.1 fix (closure plan §16): zero budget must HOLD — checked BEFORE the
  // reserve comparison, otherwise remaining=0 <= reserve wins and a broke
  // gauntlet would be told to "finalize-verify" with nothing left to spend.
  if (input.toolCallsRemaining <= 0) return 'hold';
  if (input.toolCallsRemaining <= input.verificationReserve) return 'finalize-verify';
  return 'proceed';
}
