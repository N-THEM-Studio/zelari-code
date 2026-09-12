/**
 * React hook backing the Kraken Activity panel: subscribes to the
 * `agent-event` Tauri stream and reduces it into RunActivityState.
 *
 * Conversation isolation (M2): when `conversationId` is provided, events
 * are attributed through their run envelope (`readRunEnvelope`) and only
 * that conversation's events are reduced — a background run in another
 * chat (even on another project folder) never paints this panel. This is
 * the same envelope-first routing App applies to run events; before the
 * fix every mounted panel reduced the GLOBAL stream (the Kraken Activity
 * feed leaked across concurrent conversations).
 *
 * Un-enveloped (legacy) events are accepted only while this panel's
 * conversation is the active one — the same fallback App's routing uses.
 * Switching conversation resets the tree: the panel is a live view, not
 * history (RunsDashboard is the cross-conversation overview).
 */
import { useEffect, useReducer, useRef } from "react";
import { onAgentEvent } from "../agentClient";
import { readRunEnvelope } from "../runs/types";
import { activityReducer, emptyActivityState, type ActivityAction } from "./reducer";

export interface UseRunActivityOptions {
  /** Conversation this panel belongs to. Enables envelope filtering. */
  conversationId?: string;
  /** Currently active conversation id: un-enveloped (legacy) events are
   *  accepted only while `conversationId === activeConversationId`. */
  activeConversationId?: string;
}

export function useRunActivity(opts?: UseRunActivityOptions) {
  const [state, dispatch] = useReducer(activityReducer, undefined, emptyActivityState);

  // Latest-ref: the Tauri subscription is created once; the filter always
  // reads the current options, so an active-conversation change needs no
  // re-subscribe (and never drops the unlisten handle).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Live view, not history: switching conversation clears the tree.
  const convKey = opts?.conversationId ?? "";
  useEffect(() => {
    dispatch({ kind: "reset" });
  }, [convKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onAgentEvent((ev) => {
      if (disposed) return;
      const o = optsRef.current;
      if (o?.conversationId) {
        const envConv = readRunEnvelope(ev).conversationId;
        if (envConv) {
          if (envConv !== o.conversationId) return; // another chat's run
        } else if (o.conversationId !== o.activeConversationId) {
          return; // un-attributable: only the active panel may take it
        }
      }
      dispatch({ kind: "event", ev } as ActivityAction);
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
