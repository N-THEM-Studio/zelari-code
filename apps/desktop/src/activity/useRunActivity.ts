/**
 * React hook backing the Kraken Activity panel: subscribes to the
 * `agent-event` Tauri stream and reduces it into RunActivityState.
 *
 * Conversation isolation (M2): events attributed through their run envelope
 * (`readRunEnvelope`) are ALWAYS accumulated — per conversation, in a
 * module-level store — but only this panel's conversation is painted. A
 * background run in another chat (even on another project folder) never
 * paints this panel, yet keeps building its tree, so switching back to a
 * conversation restores titles and statuses instead of skeleton rows
 * rebuilt from late events (regression 2026-09-13: the switch-away reset
 * dropped the tree, and late agent_status/agent_tool ticks re-created
 * agent stubs without metadata: "t1 ● – · reasoning").
 *
 * Panels mounted WITHOUT a conversation id keep the pre-M2 behavior: every
 * event lands in one catch-all bucket ("") and all of it is painted.
 *
 * A new mission in the SAME conversation (agent_spawned with a different
 * runId) starts from an empty tree, so finished agents from the previous
 * run never bleed into the new one.
 */
import { useEffect, useRef, useState } from "react";
import { onAgentEvent } from "../agentClient";
import { readRunEnvelope } from "../runs/types";
import { activityReducer, emptyActivityState, type ActivityAction } from "./reducer";
import type { RunActivityState } from "./types";

export interface UseRunActivityOptions {
  /** Conversation this panel belongs to. Enables envelope routing. */
  conversationId?: string;
  /** Currently active conversation id: un-enveloped (legacy) events are
   *  accepted only while `conversationId === activeConversationId`. */
  activeConversationId?: string;
}

/**
 * Latest activity tree per conversation ("" = legacy un-attributed bucket).
 * Module-level by design: it must survive panel unmounts and conversation
 * switches. Bounded by the number of conversations; each entry is a few KB.
 */
const activityStore = new Map<string, RunActivityState>();

/** Test-only: wipe the cross-switch accumulation store. */
export function clearActivityStoreForTests(): void {
  activityStore.clear();
}

export function useRunActivity(opts?: UseRunActivityOptions) {
  const convKey = opts?.conversationId ?? "";
  const [state, setState] = useState<RunActivityState>(() =>
    activityStore.get(convKey) ?? emptyActivityState(),
  );

  // Latest-ref: the Tauri subscription is created once; routing always
  // reads the current options, so a conversation change needs no
  // re-subscribe (and never drops the unlisten handle).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Follow conversation switches: hydrate the accumulated tree (titles,
  // statuses, tools) instead of restarting from an empty skeleton.
  useEffect(() => {
    setState(activityStore.get(convKey) ?? emptyActivityState());
  }, [convKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onAgentEvent((ev) => {
      if (disposed) return;
      const o = optsRef.current;
      const envConv = readRunEnvelope(ev).conversationId;
      let target: string;
      if (!o?.conversationId) {
        // Legacy panel (no conversation id): pre-M2 behavior — EVERY event
        // lands in one catch-all bucket and all of it is painted.
        target = "";
      } else if (envConv) {
        // Attributed: accumulate for its conversation — background runs
        // included — but paint only this panel's conversation.
        target = envConv;
      } else if (o.conversationId === o.activeConversationId) {
        // Un-attributable event while this panel is the active one:
        // best-effort attribution (same fallback App's routing uses).
        target = o.conversationId;
      } else {
        return; // un-attributable and not the active panel: drop
      }

      let prev = activityStore.get(target) ?? emptyActivityState();
      const rec = ev as Record<string, unknown>;
      if (
        target !== "" && // the runId guard is for per-conversation buckets only:
        // the legacy catch-all keeps the pre-M2 merge-everything semantics.
        rec.type === "agent_spawned" &&
        typeof rec.runId === "string" &&
        prev.runId !== undefined &&
        prev.runId !== rec.runId
      ) {
        prev = emptyActivityState(); // new mission in the same conversation
      }
      const next = activityReducer(prev, { kind: "event", ev } as ActivityAction);
      activityStore.set(target, next);
      // Paint rule: attributed panels paint only their conversation;
      // legacy (id-less) panels keep painting everything, as before M2.
      if (!o?.conversationId || target === o.conversationId) setState(next);
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
