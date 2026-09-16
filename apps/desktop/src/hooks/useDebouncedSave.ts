import { useCallback, useEffect, useRef } from "react";

/**
 * Trailing-edge debounced scheduler for an expensive side effect — here the
 * localStorage persistence of the conversation store. A burst of `schedule()`
 * calls (one per streamed token) collapses into a single `run()` ~`delayMs`
 * after the last call, amortising the stringify + write cost.
 *
 * `maxWaitMs` caps how long a burst may defer the save: a continuous stream
 * whose deltas keep arriving faster than `delayMs` would otherwise never fire
 * the trailing timer, so an extra timer started by the FIRST pending
 * `schedule()` guarantees a run within `maxWaitMs` of it. Whichever timer fires
 * first wins and resets both.
 *
 * `run` is read through a ref, so callers need not memoize it and the callback
 * always sees its latest closure (e.g. the newest conversations snapshot
 * captured via a ref).
 *
 * `flush()` runs a pending save immediately and synchronously — used at data
 * boundaries (run finished, chat switch/delete/new, page unload) where waiting
 * for the trailing timer could lose work. It is a no-op when nothing is pending.
 * `cancel()` drops a pending save without running it.
 */
export function useDebouncedSave(
  run: () => void,
  delayMs = 500,
  maxWaitMs?: number,
): {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
} {
  const runRef = useRef(run);
  runRef.current = run;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  // Run the pending save now and reset both timers/flags. Used by the trailing
  // timer, the maxWait timer, and flush().
  const fire = useCallback(() => {
    clearTimers();
    pendingRef.current = false;
    runRef.current();
  }, [clearTimers]);

  const flush = useCallback(() => {
    if (!pendingRef.current) return;
    fire();
  }, [fire]);

  const schedule = useCallback(() => {
    pendingRef.current = true;
    // (Re)start the trailing-edge timer: save `delayMs` after the last call.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fire, delayMs);
    // Start the maxWait cap once per pending burst (not on every call), so a
    // continuous stream still persists within `maxWaitMs` of the first schedule.
    if (maxWaitMs != null && maxWaitMs > 0 && maxTimerRef.current === null) {
      maxTimerRef.current = setTimeout(fire, maxWaitMs);
    }
  }, [delayMs, maxWaitMs, fire]);

  const cancel = useCallback(() => {
    clearTimers();
    pendingRef.current = false;
  }, [clearTimers]);

  // Never strand a pending save when the component unmounts.
  useEffect(() => flush, [flush]);

  return { schedule, flush, cancel };
}
