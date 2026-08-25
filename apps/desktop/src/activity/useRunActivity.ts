/**
 * React hook backing the Kraken Activity panel: subscribes to the
 * `agent-event` Tauri stream and reduces it into RunActivityState.
 */
import { useEffect, useReducer } from "react";
import { onAgentEvent } from "../agentClient";
import { activityReducer, emptyActivityState, type ActivityAction } from "./reducer";

export function useRunActivity() {
  const [state, dispatch] = useReducer(activityReducer, undefined, emptyActivityState);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onAgentEvent((ev) => {
      if (!disposed) dispatch({ kind: "event", ev } as ActivityAction);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return state;
}
