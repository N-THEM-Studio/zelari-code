/**
 * SLICE3(sidecar-batching): coalescing state holder for non-urgent sidecar
 * updates.
 *
 * Why: during a Kraken turn the sidecar stream (tentacle status, tool calls,
 * progress, stderr) fires a burst of events, and every event used to call a
 * `setState` on App — a ~4000-line component with 50+ hooks — so each sidecar
 * tick re-reconciled the whole app (transcript, sidebar, panels) and the
 * composer stuttered while the user typed.
 *
 * What this hook changes: the updates still ALL land, in arrival order, but
 * many events inside one window produce a SINGLE React commit. The queue holds
 * the updater functions themselves, so `flush` replays them against the
 * accumulated value — coalescing is a merge, never a drop: the settled state
 * is byte-identical to the un-batched sequence (proved in
 * useSidecarBatch.test.tsx).
 *
 * What must NOT use it: streaming text (`message_delta`) and anything the user
 * is waiting on right now (permission/ask cards, request/response, run
 * boundaries). Those stay on plain `useState` and commit per event, so the
 * transcript keeps typing smoothly.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type StateUpdate<T> = T | ((prev: T) => T);
export type StateFlush = () => void;

/**
 * Coalescing window. At most one commit per window per batched slice: long
 * enough to swallow an event burst, short enough to stay under the ~250ms
 * threshold where a UI tick starts reading as lag.
 */
export const SIDECAR_BATCH_MS = 180;

/**
 * Every live batched holder registers its flusher here, so a caller that knows
 * the burst is over (a settled turn, a visible window, a panel opening) can
 * land every pending batch with one call and without threading refs around.
 */
const flushers = new Set<StateFlush>();

/** Apply every pending batched update now — run boundaries use this so the
 * settled UI never waits for the next window. */
export function flushSidecarBatches(): void {
  for (const flush of Array.from(flushers)) flush();
}

/** Test-only: how many batched holders are currently mounted. */
export function sidecarBatchRegistrySize(): number {
  return flushers.size;
}

/**
 * `useState` with a coalescing window. Drop-in on the setter side: the second
 * element accepts a value or a functional updater, exactly like `Dispatch`.
 * The third element is this holder's own flusher (flushSidecarBatches covers
 * it too).
 */
export function useBatchedState<T>(
  initial: T | (() => T),
  delayMs: number = SIDECAR_BATCH_MS,
): [T, (update: StateUpdate<T>) => void, StateFlush] {
  const [value, setValue] = useState<T>(initial);
  const queueRef = useRef<Array<(prev: T) => T>>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback<StateFlush>(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const queued = queueRef.current;
    if (queued.length === 0) return;
    queueRef.current = [];
    setValue((prev) => queued.reduce((acc, update) => update(acc), prev));
  }, []);

  const enqueue = useCallback(
    (update: StateUpdate<T>) => {
      queueRef.current.push(
        typeof update === "function" ? (update as (prev: T) => T) : () => update,
      );
      // Leading timer, NOT a debounce: the window is armed by the first event
      // and never pushed back, so a continuous stream still paints every
      // `delayMs` instead of starving (a resetting debounce would only flush
      // when the burst finally pauses).
      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flush();
        }, delayMs);
      }
    },
    [delayMs, flush],
  );

  useEffect(() => {
    flushers.add(flush);
    // Background windows get their timers throttled (>=1s in Chromium): when
    // the user looks again, paint the pending batch immediately.
    const onVisibility = (): void => {
      if (!document.hidden) flush();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      flushers.delete(flush);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      queueRef.current = [];
    };
  }, [flush]);

  return [value, enqueue, flush];
}
