/**
 * Gauntlet Loop — display helpers for historical chats that still contain
 * the old prompt block. The send path MUST NOT append this; the toggle
 * forwards `--gauntlet` and the CLI runs a host loop.
 */
export const GAUNTLET_LOOP_MARKER = "You are running a Gauntlet Loop.";

export const GAUNTLET_LOOP_PROMPT = `${GAUNTLET_LOOP_MARKER}

Whatever the user asks next is the Goal. Treat it as the only thing that matters.

Break the Goal into the smallest pieces that can be improved and judged independently. For every important piece, fan out a specialist builder sub-agent and a completely separate, ruthless critic sub-agent that starts with fresh context.

Each critic must inspect the real output, compare it directly against the strongest concrete quality bar that exists for that piece (use blind A/B when possible), name the single biggest remaining gap, and send it back for another round.

Keep looping on every piece. Do not stop until the critics are forced to declare that the output wins against the bar, or until the user stops the run.

Maintain a simple live progress page that shows the work evolving over time.

Use subagents and ultracode. Decide the architecture, the decomposition, and the number of rounds yourself.`;

export function hasGauntletLoop(text: string): boolean {
  return text.includes(GAUNTLET_LOOP_MARKER);
}

/** Append the loop instructions once. Empty goal still receives the block. */
export function appendGauntletLoop(goal: string): string {
  const trimmed = goal.trim();
  if (hasGauntletLoop(trimmed)) return trimmed;
  if (!trimmed) return GAUNTLET_LOOP_PROMPT;
  return `${trimmed}\n\n${GAUNTLET_LOOP_PROMPT}`;
}

/** User-visible text without the loop block (chat bubble / window title). */
export function stripGauntletLoop(text: string): string {
  const idx = text.indexOf(GAUNTLET_LOOP_MARKER);
  if (idx < 0) return text;
  return text.slice(0, idx).trimEnd();
}
