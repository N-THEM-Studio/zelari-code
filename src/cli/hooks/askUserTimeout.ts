/**
 * askUserTimeout — shared timeout for promise-backed clarification pickers.
 *
 * Why this exists: ask_user, permission asks and broker questions block the
 * harness tool-loop on a Promise that only the UI picker can settle. If the
 * picker is superseded (another setPicker call), rendered off-screen, or
 * simply missed by the user, the turn used to hang forever on a silent
 * "working" spinner with no error — observed with grok-4.6 builds, where the
 * model asks mid-task clarifying questions ~10 minutes in.
 *
 * The timeout guarantees the loop always continues: resolving null/cancel
 * makes the ask_user tool return "proceed with a documented assumption", and
 * the permission gate deny with a note (the tool can be re-run).
 *
 * Default 5 minutes. Override with ZELARI_ASK_USER_TIMEOUT_MS (milliseconds;
 * 0 disables the timeout).
 */

/** Resolve the configured picker timeout in ms (0 = disabled). */
export function askUserTimeoutMs(): number {
  const raw = process.env.ZELARI_ASK_USER_TIMEOUT_MS?.trim();
  if (!raw) return 300_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 300_000;
  return n;
}

/**
 * Arm a picker timeout. Returns the cancel function — call it inside the
 * settle path (`finish`) so a picker answered/cancelled by the user never
 * fires the timeout note afterwards.
 */
export function armPickerTimeout(
  onFire: () => void,
  ms: number,
): () => void {
  if (ms <= 0) return () => undefined;
  const id = setTimeout(onFire, ms);
  return () => clearTimeout(id);
}
