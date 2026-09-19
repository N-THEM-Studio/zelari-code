/**
 * runawayGuard.ts — per-session anti-loop tracker (core/modules/runaway-guard).
 *
 * Two independent runaway signatures, each with its own reachable verdict so
 * the harness can react at the point where it can actually act:
 *
 * - REPETITION (pre-dispatch): N ≥ 3 CONSECUTIVE tool calls with the same tool
 *   and the same arguments (deterministic sha256 over the canonicalized args)
 *   → `'warn'`. The call still proceeds: the verdict is an advisory signal for
 *   the host (log / steer the model). The harness owns the harder reaction
 *   (its own doom_loop counter refuses the 3rd identical invite at the
 *   registry), so this tracker never escalates on repetition.
 * - STALL (turn boundary): K consecutive turns (default 5) in which NEITHER
 *   the tool calls NOR the tool results introduced anything new → `'abort'`.
 *   The host ends the current turn instead of paying for another provider
 *   round-trip on identical work.
 *
 * State is per session/run; {@link RunawayGuard.reset} drops everything (the
 * harness calls it at the start of every `run()`).
 *
 * Kill-switch: `ZELARI_RUNAWAY_GUARD=0` → every verdict is `'allow'`. The
 * value is re-read on each decision, so flipping it mid-run takes effect.
 * Fail-soft: hosts must wrap calls in {@link guardSafely} so a poisoned
 * argument (throwing getter) degrades to `'allow'` instead of breaking a tool
 * dispatch (P1 — degrade-and-stop).
 *
 * No I/O, no timers, no deps beyond the shared canonical hashing.
 *
 * @since v2.51.0
 */
import { sha256Hex, stableStringify } from '../../requestSnapshot.js';

/** Policy carried by a tracker verdict. */
export type RunawayPolicy = 'allow' | 'warn' | 'abort';

/** A verdict plus a human-readable reason (`''` when policy is 'allow'). */
export interface RunawayVerdict<P extends RunawayPolicy = RunawayPolicy> {
  policy: P;
  reason: string;
}

/** Pre-dispatch verdict — repetition policy only. */
export type ToolCallVerdict = RunawayVerdict<'allow' | 'warn'>;
/** Turn-boundary verdict — stall policy only. */
export type TurnVerdict = RunawayVerdict<'allow' | 'abort'>;

/** Env kill-switch (`'0'` disables the guard entirely). */
export const RUNAWAY_GUARD_ENV = 'ZELARI_RUNAWAY_GUARD';
/** Identical consecutive calls before 'warn' (spec: N ≥ 3). */
export const DEFAULT_IDENTICAL_THRESHOLD = 3;
/** Turns without new tool calls/results before 'abort'. */
export const DEFAULT_STALL_TURNS = 5;

const ALLOW: RunawayVerdict<'allow'> = { policy: 'allow', reason: '' };

/** False only when the kill-switch is explicitly `'0'`. */
export function runawayGuardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[RUNAWAY_GUARD_ENV] ?? '').trim() !== '0';
}

/**
 * Deterministic call key: sha256 over the canonicalized args (object key order
 * does not matter), prefixed with the tool name so different tools with equal
 * args never collide.
 */
export function toolCallHash(toolName: string, args: unknown): string {
  return `${toolName}:${sha256Hex(stableStringify(args ?? null))}`;
}

/** What one finished turn produced (both fields are evidence of progress). */
export interface TurnObservation {
  /** {@link toolCallHash} of every tool call the turn dispatched. */
  callKeys?: readonly string[];
  /** Result texts the turn returned (hashed here; order-insensitive). */
  results?: readonly string[];
}

export interface RunawayGuardOptions {
  /** Consecutive identical calls before 'warn' (default 3). */
  identicalThreshold?: number;
  /** Unproductive turns before 'abort' (default 5). */
  stallTurns?: number;
  /** Override the kill-switch (tests / hosts). Default: read the env. */
  enabled?: boolean;
}

export class RunawayGuard {
  private readonly identicalThreshold: number;
  private readonly stallTurns: number;
  private readonly enabledOverride: boolean | undefined;
  private readonly env: Record<string, string | undefined>;
  /** Last dispatched call key + how many times it repeated consecutively. */
  private lastKey: string | null = null;
  private repeatStreak = 0;
  /** Cumulative progress knowledge for the stall detector (per session). */
  private readonly knownCalls = new Set<string>();
  private readonly knownResults = new Set<string>();
  private stalledTurns = 0;

  constructor(
    options: RunawayGuardOptions = {},
    env: Record<string, string | undefined> = process.env,
  ) {
    this.identicalThreshold = positiveInt(
      options.identicalThreshold,
      DEFAULT_IDENTICAL_THRESHOLD,
    );
    this.stallTurns = positiveInt(options.stallTurns, DEFAULT_STALL_TURNS);
    this.enabledOverride = options.enabled;
    this.env = env;
  }

  /** True when the tracker is active (kill-switch not set). */
  get enabled(): boolean {
    return this.enabledOverride ?? runawayGuardEnabled(this.env);
  }

  /**
   * Consult BEFORE dispatching a tool call. Only `'allow'` / `'warn'` can come
   * back — the stall verdict is a turn-level decision ({@link checkTurn}).
   */
  checkToolCall(toolName: string, args: unknown): ToolCallVerdict {
    if (!this.enabled) return ALLOW;
    const key = toolCallHash(toolName, args);
    if (key === this.lastKey) {
      this.repeatStreak += 1;
    } else {
      this.lastKey = key;
      this.repeatStreak = 1;
    }
    if (this.repeatStreak >= this.identicalThreshold) {
      return {
        policy: 'warn',
        reason:
          `tool "${toolName}" called ${this.repeatStreak}× in a row with identical arguments — ` +
          'change approach or answer with what is already known.',
      };
    }
    return ALLOW;
  }

  /**
   * Consult at a turn boundary with everything the turn produced. A turn with
   * no tool call and no result is NEUTRAL (pure synthesis is not stall
   * evidence) and leaves the counter untouched. The stall counter resets as
   * soon as a new call key or a new result digest shows up, so a recovering
   * run clears itself.
   */
  checkTurn(observation: TurnObservation): TurnVerdict {
    if (!this.enabled) return ALLOW;
    const callKeys = observation.callKeys ?? [];
    const results = observation.results ?? [];
    if (callKeys.length === 0 && results.length === 0) return ALLOW;

    let progress = false;
    for (const key of callKeys) {
      if (!this.knownCalls.has(key)) {
        this.knownCalls.add(key);
        progress = true;
      }
    }
    for (const text of results) {
      const digest = sha256Hex(String(text ?? ''));
      if (!this.knownResults.has(digest)) {
        this.knownResults.add(digest);
        progress = true;
      }
    }

    this.stalledTurns = progress ? 0 : this.stalledTurns + 1;
    if (this.stalledTurns >= this.stallTurns) {
      return {
        policy: 'abort',
        reason:
          `no new tool call or tool result for ${this.stalledTurns} consecutive turns — ` +
          'the run is repeating itself; stop and reassess.',
      };
    }
    return ALLOW;
  }

  /** Drop all per-run state (called by the harness at the start of a run). */
  reset(): void {
    this.lastKey = null;
    this.repeatStreak = 0;
    this.knownCalls.clear();
    this.knownResults.clear();
    this.stalledTurns = 0;
  }
}

/**
 * Fail-soft wrapper (P1 degrade-and-stop): a throw inside `fn` — including a
 * poisoned argument with a throwing getter — degrades to `'allow'` and is
 * reported to the optional sink. This helper never throws.
 */
export function guardSafely(
  fn: () => RunawayVerdict,
  onError?: (message: string) => void,
): RunawayVerdict {
  try {
    return fn();
  } catch (err) {
    const message =
      `guard crashed — allowing (fail-soft): ${err instanceof Error ? err.message : String(err)}`;
    try {
      onError?.(message);
    } catch {
      // A failing sink must never break a tool dispatch.
    }
    return { policy: 'allow', reason: message };
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}
