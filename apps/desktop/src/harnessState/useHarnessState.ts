/**
 * React hook for the advisory `harness-state` Tauri event (the sidecar's
 * relay of the CLI's final harness_state NDJSON read-model). Fix E (t62):
 * the event carries the SPINE `sessionId` it belongs to, so state is kept
 * PER SESSION (a Map) instead of one global "last" slot — a background run's
 * context can no longer overwrite the meter of the chat on screen. A caller
 * asks for the session it cares about and gets that session's last snapshot
 * (or an empty view). A malformed payload yields a null view (the panel
 * disappears — the event is advisory, never an error surface). Also stamps
 * WHEN the last event for that session arrived: the context meter's
 * freshness clock (computeContextMeter).
 */
import { useEffect, useState } from "react";
import { onHarnessState } from "../agentClient";
import { readHarnessStateEvent, type HarnessStateView } from "./normalize";

export interface HarnessStateSnapshot {
  view: HarnessStateView | null;
  /** Date.now() when the last harness-state event for THIS session arrived. */
  receivedAt: number | null;
}

const EMPTY_SNAPSHOT: HarnessStateSnapshot = { view: null, receivedAt: null };

/**
 * @param sessionId Spine session id of the caller's conversation. Selects the
 *   per-session snapshot; `null`/unknown ⇒ the empty snapshot (never the last
 *   event of another chat).
 */
export function useHarnessState(
  sessionId?: string | null,
): HarnessStateSnapshot {
  const [bySession, setBySession] = useState<
    Record<string, HarnessStateSnapshot>
  >({});

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onHarnessState((payload) => {
      if (disposed) return;
      // Fix E (t62): key by the spine session the event belongs to. An
      // event with no sessionId is un-attributable → dropped, never guessed
      // onto whichever chat happens to be open.
      const sid = payload?.sessionId;
      if (!sid) return;
      setBySession((prev) => ({
        ...prev,
        [sid]: {
          view: readHarnessStateEvent(payload?.state),
          receivedAt: Date.now(),
        },
      }));
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

  return (sessionId && bySession[sessionId]) || EMPTY_SNAPSHOT;
}
