/**
 * subagentLoopGuard — cross-turn degenerate-loop guard for tentacles
 * (t157 · 2026-09-21 tentacle plan P2c).
 *
 * Observed failure mode: an `explore` tentacle re-emitted the SAME assistant
 * sentence on ~30 consecutive tool-loop turns until its turn budget ran out —
 * nothing detected it and nothing told the parent it had stalled.
 *
 * What this guards, exactly: the COMPLETED assistant message of each turn.
 * Tool calls are deliberately NOT inspected — re-running the same command is
 * legitimate (a verify tentacle retries the same check on purpose), while
 * re-emitting the same prose is not. Core already owns the complementary
 * INTRA-message detector (`detectAssistantTextLoop` / the `assistant_text_loop`
 * error event in `@zelari/core/harness`), which fires when ONE message repeats
 * a block while streaming; the incident shape — one repetition per turn —
 * slips past it, which is the gap this module closes.
 *
 * Purity contract: no I/O, no network, no clock, deterministic. The tentacle
 * loop feeds it one message per turn; the tests drive it directly.
 */

/**
 * Consecutive identical non-trivial messages that mean "degenerate".
 * Three is the plan's threshold: a legitimate run may repeat a line twice
 * (e.g. a re-check after a failure), a stalled one never stops.
 */
export const DEGENERATE_LOOP_THRESHOLD = 3;

/**
 * A normalized message must be STRICTLY longer than this to be countable.
 * Short acknowledgements ("OK", "Done", "Running the tests") are normal
 * progress chatter, not a loop — only real status theater counts.
 */
export const DEGENERATE_MIN_LENGTH = 40;

/** Cap of the normalized sample echoed to the parent (context economy). */
export const DEGENERATE_SAMPLE_MAX = 120;

/** Verdict for one observed assistant message. */
export interface LoopGuardVerdict {
  /** True when the guard tripped on THIS observation. */
  degenerate: boolean;
  /** Length of the current consecutive-identical run (1 on a fresh output). */
  repetitions: number;
  /** Normalized (lowercase + collapsed whitespace) sample, capped. */
  sample: string;
}

/** Degenerate-loop stop, recorded by the loop and surfaced to the parent. */
export interface DegenerateLoopStop {
  /** 1-based count of completed assistant messages when the guard tripped. */
  turn: number;
  /** Consecutive identical messages observed (>= DEGENERATE_LOOP_THRESHOLD). */
  repetitions: number;
  /** Normalized sample of the repeated output (capped). */
  sample: string;
}

/** Stateful counter over the assistant messages of one sub-agent run. */
export interface LoopGuard {
  /** Feed the COMPLETED assistant text of a turn; never throws. */
  observe(text: string): LoopGuardVerdict;
  /** Forget the streak (fresh run, or after the caller handled a verdict). */
  reset(): void;
}

/**
 * Normalize for comparison: lowercase + whitespace collapse + trim.
 * Casing and reflowed whitespace are the two variations a model produces
 * while "repeating" the same sentence, so they must not defeat the guard.
 */
export function normalizeAssistantText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Create a guard for a single sub-agent run.
 *
 * Counting rule (conservative on purpose — the plan's risk register lists
 * false positives FIRST): only a normalized output IDENTICAL to the previous
 * one extends the run; ANY different output — including an empty or
 * too-short one — restarts it at 1. So an interleaved "OK" or a tool-only
 * turn costs the guard a fresh streak instead of tripping it, and a false
 * stop is only possible when the same >40-char text really does end three
 * turns in a row.
 */
export function createLoopGuard(): LoopGuard {
  let previous: string | null = null;
  let repetitions = 0;

  return {
    observe(text: string): LoopGuardVerdict {
      const normalized = normalizeAssistantText(text);
      if (normalized !== '' && normalized === previous) {
        repetitions += 1;
      } else {
        previous = normalized;
        repetitions = 1;
      }
      return {
        degenerate:
          normalized.length > DEGENERATE_MIN_LENGTH &&
          repetitions >= DEGENERATE_LOOP_THRESHOLD,
        repetitions,
        sample: normalized.slice(0, DEGENERATE_SAMPLE_MAX),
      };
    },
    reset(): void {
      previous = null;
      repetitions = 0;
    },
  };
}

/**
 * Parent-facing one-liner for a guard stop. Single source of truth so the
 * `task` tool result, the radio event and the tests all say the same thing;
 * the caller adds the partial output (it owns that data and its cap).
 */
export function formatDegenerateLoopStop(stop: DegenerateLoopStop): string {
  return (
    `degenerate loop detected: same assistant output repeated ${stop.repetitions} ` +
    `times at turn ${stop.turn} — sub-agent stopped before spending the rest of ` +
    `its turn budget` +
    (stop.sample ? ` | sample: "${stop.sample}"` : '')
  );
}
