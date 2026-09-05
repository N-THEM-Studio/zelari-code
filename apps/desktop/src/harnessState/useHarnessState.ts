/**
 * React hook for the advisory `harness-state` Tauri event (the sidecar's
 * relay of the CLI's final harness_state NDJSON read-model). Keeps the LAST
 * state only; a malformed payload clears the view (the panel disappears —
 * the event is advisory, never an error surface). Also stamps WHEN the last
 * event arrived: the context meter's freshness clock (computeContextMeter).
 */
import { useEffect, useState } from "react";
import { onHarnessState } from "../agentClient";
import { readHarnessStateEvent, type HarnessStateView } from "./normalize";

export interface HarnessStateSnapshot {
  view: HarnessStateView | null;
  /** Date.now() when the LAST harness-state event arrived; null before. */
  receivedAt: number | null;
}

export function useHarnessState(): HarnessStateSnapshot {
  const [snap, setSnap] = useState<HarnessStateSnapshot>({
    view: null,
    receivedAt: null,
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onHarnessState((payload) => {
      if (disposed) return;
      setSnap({ view: readHarnessStateEvent(payload?.state), receivedAt: Date.now() });
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined); // non-Tauri context: stay inert
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return snap;
}
