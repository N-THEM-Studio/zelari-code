/**
 * Cooperative cancel for a council run.
 *
 * Desktop Stop maps to `session.cancel` → AbortSignal. The current member
 * AgentHarness is cancelled (provider stream abort) and remaining members
 * / retries are skipped. No-op when `signal` is omitted (TUI / tests).
 */
import type { AgentHarness } from '../../core/AgentHarness.js';
import type { BrainEvent } from '../../shared/events.js';

export function isCouncilCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Wire AbortSignal → harness.cancel(). Returns a disposer. */
export function bindHarnessAbort(
  harness: AgentHarness,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    harness.cancel();
    return () => undefined;
  }
  const onAbort = (): void => {
    harness.cancel();
  };
  signal.addEventListener('abort', onAbort);
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}

export async function* runHarnessWithAbort(
  harness: AgentHarness,
  signal?: AbortSignal,
): AsyncIterable<BrainEvent> {
  const unbind = bindHarnessAbort(harness, signal);
  try {
    yield* harness.run();
  } finally {
    unbind();
  }
}
