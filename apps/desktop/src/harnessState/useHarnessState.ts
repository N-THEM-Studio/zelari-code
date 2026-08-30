/**
 * React hook for the advisory `harness-state` Tauri event (the sidecar's
 * relay of the CLI's final harness_state NDJSON read-model). Keeps the LAST
 * state only; a malformed payload clears the view (the panel disappears —
 * the event is advisory, never an error surface).
 */
import { useEffect, useState } from "react";
import { onHarnessState } from "../agentClient";
import { readHarnessStateEvent, type HarnessStateView } from "./normalize";

export function useHarnessState(): HarnessStateView | null {
  const [view, setView] = useState<HarnessStateView | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onHarnessState((payload) => {
      if (disposed) return;
      setView(readHarnessStateEvent(payload?.state));
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

  return view;
}
