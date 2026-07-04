import { useEffect, useRef, useState } from 'react';

/**
 * useExecutionTimer — elapsed-time tracker for the current chat turn (v0.7.9).
 *
 * While `busy` is true the hook ticks every `tickMs` (default 1s) and
 * reports the milliseconds since the turn started; when the turn ends the
 * duration is frozen into `lastMs` so the StatusBar can keep showing how
 * long the previous run took.
 */
export interface ExecutionTimer {
  /** Milliseconds elapsed in the current run; null while idle. */
  elapsedMs: number | null;
  /** Duration of the last completed run; null before the first run. */
  lastMs: number | null;
}

export function useExecutionTimer(busy: boolean, tickMs = 1000): ExecutionTimer {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy) {
      startRef.current = Date.now();
      setElapsedMs(0);
      const t = setInterval(() => {
        if (startRef.current !== null) setElapsedMs(Date.now() - startRef.current);
      }, tickMs);
      return () => clearInterval(t);
    }
    if (startRef.current !== null) {
      setLastMs(Date.now() - startRef.current);
      startRef.current = null;
    }
    setElapsedMs(null);
    return undefined;
  }, [busy, tickMs]);

  return { elapsedMs, lastMs };
}
