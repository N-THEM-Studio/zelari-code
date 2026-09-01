/**
 * Sidecar stderr diagnostics (harness-sidecar-log panel).
 *
 * The Rust sidecar drains the child's stderr line-by-line and emits each
 * line as `harness-sidecar-log` `{ line }` (also appended to
 * logs/zelari-sidecar.log). The frontend keeps the last N lines in a ring
 * buffer; pure helpers here so the cap + error emphasis are unit-testable.
 */

/** Panel keeps the most recent lines only (stderr is noisy on boot). */
export const SIDECAR_LOG_RING_CAPACITY = 200;

/**
 * Append one line to the ring buffer, dropping the oldest beyond capacity.
 * Pure: returns a new array, never mutates the input.
 */
export function pushSidecarLogLine(
  lines: string[],
  line: string,
  capacity: number = SIDECAR_LOG_RING_CAPACITY,
): string[] {
  const next = [...lines, line];
  return next.length > capacity
    ? next.slice(next.length - capacity)
    : next;
}

/** Error-ish stderr lines get visual emphasis in the panel. */
const SIDECAR_ERROR_RE =
  /\b(error|errore|fatal|panic|failed|failure|exception|traceback|uncaught|unreachable|refused|econnrefused|enoent|exited with|exit code:?\s*[1-9])\b/i;

/** Rust panic / backtrace framing (multi-line panics). */
const RUST_PANIC_RE =
  /^thread '.*' panicked|^stack backtrace:|^note: (?:some details are omitted|run with `RUST_BACKTRACE`)/i;

export function isSidecarErrorLine(line: string): boolean {
  return SIDECAR_ERROR_RE.test(line) || RUST_PANIC_RE.test(line);
}

/**
 * Normalize a `harness-sidecar-log` payload to its line text. The Rust emit
 * is `{ line }`; a bare string (and junk) is tolerated so a backend shape
 * drift never silently empties the diagnostics panel.
 */
export function sidecarLogLineFromPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null) {
    const line = (payload as { line?: unknown }).line;
    if (typeof line === "string") return line;
  }
  return "";
}
