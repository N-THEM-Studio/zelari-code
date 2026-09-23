/**
 * mutationGuard — circuit breaker for consecutive FAILED mutations in a
 * tentacle tool-loop (post-mortem 2026-09-23, G1).
 *
 * Observed failure mode: a `general` tentacle burned its ENTIRE 45-minute
 * wall-clock cap (2700 s) in a retry storm — `write_file → EACCES: permission
 * denied`, then `edit → stale_snapshot`, over and over (Windows I/O / AV
 * storm). ZERO mutations landed, nothing stopped it early, and the whole
 * budget was consumed producing nothing. This guard stops the run at the 4th
 * consecutive failed mutation instead.
 *
 * Same pattern and purity contract as `subagentLoopGuard` (t157): no I/O, no
 * network, no clock, deterministic. The tentacle loop feeds it one completed
 * tool call per `observe()`; the tests drive it directly.
 *
 * Counting rules (deliberately conservative — false stops first on the risk
 * register, same as the loop guard):
 *   - ONLY write-tool calls count (same classification as `taskTouchGuard` /
 *     `missionSlice`): `write_file` / `edit` / `edit_file` / `apply_diff` and
 *     the `mcp_filesystem_*` write family.
 *   - Read-only (and unknown) tools NEITHER increment NOR reset the streak:
 *     reads are free and ubiquitous inside a retry loop, so an interleaved
 *     `read_file` must neither hide a storm nor fabricate progress.
 *   - ANY failed mutation counts, whatever the failure shape: the structured
 *     reject channel (`stale_snapshot` / `file_exists` / `parse_error` /
 *     EACCES … — stringified by the harness as a tool error) or a non-zero
 *     `exitCode` on a command-shaped writer.
 *   - A SUCCESSFUL mutation resets the counter to zero: one landed write means
 *     the storm is over and the tentacle is making real progress.
 */

/**
 * Consecutive failed mutations that mean "storm". Four is the post-mortem's
 * shape: two different rejects repeated (`write_file` EACCES, `edit`
 * stale_snapshot) already prove the write path is broken — one retry pair per
 * distinct failure is generous, a fifth attempt would burn more budget for
 * nothing.
 */
export const MUTATION_FAILURE_THRESHOLD = 4;

/** Cap of the failure sample echoed to the parent (context economy). */
export const MUTATION_FAILURE_SAMPLE_MAX = 120;

/** Native mutating tools (catalog names) — mirrors taskTouchGuard/missionSlice. */
const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit',
  'edit_file',
  'apply_diff',
]);

/** MCP filesystem write family — same regex as `taskTouchGuard`. */
const MCP_FS_WRITE_RE = /^mcp_filesystem_(write_file|edit_file|move_file|create_directory)$/;

/** One completed tool call, already reduced to its structured outcome. */
export interface MutationOutcome {
  /** Tool name — classification is name-based (`isMutationTool`). */
  tool: string;
  /**
   * True when the tool returned a structured error: the WriteReject channel
   * (`stale_snapshot`, `file_exists`, EACCES …) is stringified as a tool error
   * by the harness, so `isError` is the deterministic failure bit.
   */
  isError: boolean;
  /**
   * Exit code when the (command-shaped) writer reports one; non-zero counts
   * as a failed mutation even without `isError`. `null`/absent = no structured
   * exit code (the common case for file writers).
   */
  exitCode?: number | null;
  /** Raw failure text sample for the parent-facing stop line (cosmetic). */
  detail?: string;
}

/** Capped sample of the most recent failing mutation. */
export interface MutationFailureSample {
  tool: string;
  detail?: string;
}

/** Verdict for one observed tool call. */
export interface MutationGuardVerdict {
  /** True once the consecutive-failure streak reached the threshold. */
  mutationStorm: boolean;
  /** Current consecutive-failed-mutations streak (0 after a landed write). */
  consecutiveFailures: number;
  /** True when this outcome was COUNTED (a write call); false for reads. */
  counted: boolean;
  /** Most recent failing mutation sample, if any failure was observed. */
  lastFailure?: MutationFailureSample;
}

/** Mutation-storm stop, recorded by the loop and surfaced to the parent. */
export interface MutationStormStop {
  /** Stable machine-readable stop code (NOT budget exhaustion, NOT a provider error). */
  code: 'mutation_storm';
  /** Consecutive failed mutations observed (>= MUTATION_FAILURE_THRESHOLD). */
  consecutiveFailures: number;
  /** What kept failing, capped — for a diagnosis without a re-run. */
  lastFailure?: MutationFailureSample;
}

/** Stateful counter over the tool calls of one sub-agent run. */
export interface MutationGuard {
  /** Feed one COMPLETED tool call; never throws. */
  observe(outcome: MutationOutcome): MutationGuardVerdict;
  /** Forget the streak (fresh run, or after the caller handled a stop). */
  reset(): void;
}

/** True for the write-tool family only (reads and probes are not mutations). */
export function isMutationTool(tool: string): boolean {
  return MUTATION_TOOL_NAMES.has(tool) || MCP_FS_WRITE_RE.test(tool);
}

/**
 * Structural failure predicate: a structured reject (`isError`) or a non-zero
 * exit code. Both shapes are counted; neither requires reading the prose.
 */
export function isMutationFailure(outcome: MutationOutcome): boolean {
  return (
    outcome.isError ||
    (typeof outcome.exitCode === 'number' && Number.isFinite(outcome.exitCode) && outcome.exitCode !== 0)
  );
}

/**
 * Structured exit code of a completed tool call, when there is one. The
 * harness stringifies OK values as JSON (spineFileEvents contract) and
 * rejects as prose, so a command-shaped writer's `{ exitCode }` arrives as a
 * JSON record — decoded here deterministically. Returns null when the result
 * carries no structured exit code (file writers, prose rejects).
 */
export function exitCodeFromToolResult(result: string): number | null {
  try {
    const parsed: unknown = JSON.parse(result);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const code = (parsed as { exitCode?: unknown }).exitCode;
      if (typeof code === 'number' && Number.isFinite(code)) return code;
    }
  } catch {
    /* prose result (reject channel) — no structured exit code */
  }
  return null;
}

/**
 * Create a mutation guard for a single sub-agent run.
 *
 * Counting rule (see the module header): only write-tool outcomes move the
 * counter — a failed mutation extends the streak, a landed mutation resets it
 * to zero, and read-only tools leave it exactly where it is.
 */
export function createMutationGuard(): MutationGuard {
  let consecutiveFailures = 0;
  let lastFailure: MutationFailureSample | undefined;

  return {
    observe(outcome: MutationOutcome): MutationGuardVerdict {
      if (!isMutationTool(outcome.tool)) {
        // Deliberate blind spot (documented rule): read-only tools neither
        // increment nor reset. A read between two failures must not launder
        // the streak away, and a failing read is not the guarded failure mode.
        return {
          mutationStorm: consecutiveFailures >= MUTATION_FAILURE_THRESHOLD,
          consecutiveFailures,
          counted: false,
          ...(lastFailure ? { lastFailure } : {}),
        };
      }
      if (!isMutationFailure(outcome)) {
        // One landed mutation ends the storm.
        consecutiveFailures = 0;
        lastFailure = undefined;
        return { mutationStorm: false, consecutiveFailures: 0, counted: true };
      }
      consecutiveFailures += 1;
      const detail = (outcome.detail ?? '').trim().slice(0, MUTATION_FAILURE_SAMPLE_MAX);
      lastFailure = { tool: outcome.tool, ...(detail ? { detail } : {}) };
      return {
        mutationStorm: consecutiveFailures >= MUTATION_FAILURE_THRESHOLD,
        consecutiveFailures,
        counted: true,
        lastFailure,
      };
    },
    reset(): void {
      consecutiveFailures = 0;
      lastFailure = undefined;
    },
  };
}

/**
 * Parent-facing one-liner for a guard stop. Single source of truth so the
 * `task` tool result, the radio event and the tests all say the same thing
 * (same contract as `formatDegenerateLoopStop`).
 */
export function formatMutationStop(stop: MutationStormStop): string {
  return (
    `mutation storm detected: ${stop.consecutiveFailures} consecutive write-tool calls ` +
    `failed without a single successful mutation — sub-agent stopped before burning ` +
    `the rest of its budget in a retry storm` +
    (stop.lastFailure
      ? ` | last: ${stop.lastFailure.tool}${stop.lastFailure.detail ? ` — "${stop.lastFailure.detail}"` : ''}`
      : '')
  );
}
