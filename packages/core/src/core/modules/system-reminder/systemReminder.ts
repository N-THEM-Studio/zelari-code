/**
 * systemReminder.ts — contextual reminder builder (core/modules/system-reminder).
 *
 * PURE: no I/O, no timers, no state — the output is a function of the input
 * (plus the explicit `env` used by the kill-switch). The host owns the inputs
 * (pending todos, remaining budget, turns since the last reminder) and the
 * decision of WHERE the text enters the model context.
 *
 * Contract:
 * - A reminder is due only every `cadenceTurns` turns (default 5): the caller
 *   passes `turnsSinceLastReminder` and gets `null` until the cadence is met.
 * - Pending todos are the payload (max {@link MAX_REMINDER_TODOS} lines; the
 *   rest is summarized as `+N more`). No todos → `null` (nothing to remind).
 * - The budget line is included ONLY below {@link BUDGET_WARN_PCT} (50%)
 *   remaining — above that it is noise the model already sees elsewhere.
 *
 * Kill-switch: `ZELARI_SYSTEM_REMINDER=0` → always `null`.
 *
 * WIRING (deliberately not connected here): the canonical model-context
 * compiler is the CLI budget pipeline (ADR-0032 —
 * `src/cli/budget/modelContextBuilder.ts`), whose `assembleRequestTail` appends
 * this text after RESOURCE STATUS + the working-set one-pager on the volatile
 * `requestTail` (request-only, never persisted). That seam lives OUTSIDE this
 * package, so the module ships complete + pure and the harness carries a
 * `// TODO(seam)` note at its nearest provider-view seam
 * (`messagesForProvider`), which must NOT wire it. The host owns every input:
 * the open session todos, a per-USER-turn counter, the remaining budget, and
 * the reset once the tail it just built carried the marker.
 *
 * @since v2.51.0
 */
/** Env kill-switch (`'0'` disables reminders entirely). */
export const SYSTEM_REMINDER_ENV = 'ZELARI_SYSTEM_REMINDER';
/** Stable marker so hosts/tests can detect (and de-duplicate) a reminder. */
export const SYSTEM_REMINDER_MARKER = '[system-reminder]';
/** Turns between two reminders when `cadenceTurns` is not given. */
export const DEFAULT_CADENCE_TURNS = 5;
/** Rendered todo lines per reminder; the remainder becomes `+N more`. */
export const MAX_REMINDER_TODOS = 5;
/** Remaining-budget percentage below which the budget line is added. */
export const BUDGET_WARN_PCT = 50;

export interface SystemReminderInput {
  /** Open todos, in priority order. Empty → `null`. */
  pendingTodos: readonly string[];
  /** Remaining resource budget (0–100). Rendered only below 50%. */
  budgetRemainingPct?: number;
  /** Turns elapsed since the last reminder (host-maintained counter). */
  turnsSinceLastReminder: number;
  /** Reminder period in turns (default {@link DEFAULT_CADENCE_TURNS}). */
  cadenceTurns?: number;
}

/** False only when the kill-switch is explicitly `'0'`. */
export function systemReminderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[SYSTEM_REMINDER_ENV] ?? '').trim() !== '0';
}

/**
 * Build the reminder text, or `null` when it is not the moment (kill-switch,
 * cadence not reached, or no pending todo to report).
 */
export function buildSystemReminder(
  input: SystemReminderInput,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!systemReminderEnabled(env)) return null;

  const cadence = positiveInt(input.cadenceTurns, DEFAULT_CADENCE_TURNS);
  const turns = Number.isFinite(input.turnsSinceLastReminder)
    ? Math.max(0, Math.floor(input.turnsSinceLastReminder))
    : 0;
  if (turns < cadence) return null;

  const todos = (input.pendingTodos ?? [])
    .map((todo) => (typeof todo === 'string' ? todo.replace(/\s+/g, ' ').trim() : ''))
    .filter((todo) => todo.length > 0);
  if (todos.length === 0) return null;

  const shown = todos.slice(0, MAX_REMINDER_TODOS);
  const lines = [
    `${SYSTEM_REMINDER_MARKER} ${todos.length} pending todo${todos.length === 1 ? '' : 's'} — ` +
      'keep the thread and finish these before starting new scope:',
    ...shown.map((todo) => `- ${todo}`),
  ];
  if (todos.length > shown.length) {
    lines.push(`- … (+${todos.length - shown.length} more)`);
  }

  const pct = input.budgetRemainingPct;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct < BUDGET_WARN_PCT) {
    lines.push(
      `Budget remaining: ${Math.max(0, Math.round(pct))}% — prefer closing the open todos over new work.`,
    );
  }

  return lines.join('\n');
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}
