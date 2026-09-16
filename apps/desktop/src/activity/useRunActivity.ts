/**
 * React hook backing the Kraken Activity panel: subscribes to the
 * `agent-event` Tauri stream and reduces it into RunActivityState.
 *
 * Conversation isolation (M2): the run envelope's `conversationId` is the
 * ONLY routing key. Rust stamps it on every line it fans out (per receiving
 * run, broadcast residue included), so the panel can be certain which chat an
 * event belongs to. Attributed events are ALWAYS accumulated — per
 * conversation, in a module-level store — but only this panel's conversation
 * is painted. A background run in another chat (even on another project
 * folder) never paints this panel, yet keeps building its tree, so switching
 * back to a conversation restores titles and statuses instead of skeleton
 * rows rebuilt from late events (regression 2026-09-13: the switch-away reset
 * dropped the tree, and late agent_status/agent_tool ticks re-created agent
 * stubs without metadata: "t1 ● – · reasoning").
 *
 * NO guessing (cross-talk fix): an event whose envelope carries no
 * conversationId is IGNORED. The previous best-effort attribution ("while
 * this panel is the active one, accept it") was the same fallback App's
 * router used, and it let a run started in chat A paint into chat B's panel
 * whenever B happened to be on screen. There is no un-attributed catch-all
 * bucket any more: every bucket is a real conversation id, and a panel with
 * no conversationId prop (a legacy/mis-wired mount) paints nothing.
 *
 * A new mission in the SAME conversation (agent_spawned with a different
 * runId) starts from an empty tree, so finished agents from the previous
 * run never bleed into the new one.
 *
 * SLICE7(run-activity-batching): the tree is PAINTED through the shared
 * coalescing holder (`useBatchedState`) instead of a plain `useState`.
 *
 * Why: `agent-event` is the busiest stream of a Kraken run (spawns, status
 * ticks, tool starts/ends) and App consumes this same hook, so every single
 * event used to commit the whole ~4000-line app. The module store below still
 * reduces EVERY event, in arrival order — batching changes the paint, never
 * the data: the queue replays each update against the accumulated value, so a
 * flush (window elapse, or `flushSidecarBatches()` at message/run boundaries
 * in App) lands the complete tree, byte-identical to the un-batched sequence.
 */
import { useEffect, useRef } from "react";
import { onAgentEvent } from "../agentClient";
import { readRunEnvelope } from "../runs/types";
import { useBatchedState } from "../hooks/useSidecarBatch";
import { activityReducer, emptyActivityState, type ActivityAction } from "./reducer";
import type { RunActivityState } from "./types";

export interface UseRunActivityOptions {
  /**
   * Conversation this panel belongs to. It is both the routing key and the
   * paint key: events are accumulated under their envelope conversation and
   * painted only when that id equals this one. Omitted = the panel is inert
   * (no envelope can ever match it) — never a global/unfiltered panel.
   */
  conversationId?: string;
}

/**
 * Latest activity tree per conversation, keyed by the envelope's
 * conversationId ("overlay"/"automation" runs land in their own buckets and
 * are simply never painted by a chat panel). Module-level by design: it must
 * survive panel unmounts and conversation switches. Bounded by the number of
 * conversations; each entry is a few KB.
 */
const activityStore = new Map<string, RunActivityState>();

/** Test-only: wipe the cross-switch accumulation store. */
export function clearActivityStoreForTests(): void {
  activityStore.clear();
}

/** Test-only: the accumulated (un-painted) tree for a conversation. */
export function readActivityStoreForTests(
  conversationId: string,
): RunActivityState | undefined {
  return activityStore.get(conversationId);
}

export function useRunActivity(opts?: UseRunActivityOptions) {
  const convKey = opts?.conversationId ?? "";
  /**
   * Batched paint (see the module header). The shared window
   * (SIDECAR_BATCH_MS, leading-edge throttle) keeps the tree ~180ms fresh —
   * far under the 1s ticker the panel already uses for elapsed durations — and
   * never starves a continuous stream. Panel visibility is deliberately NOT a
   * gate: App consumes this same hook for the open trace panel's live row, so
   * an "only while visible" mode would leave that row behind. The store keeps
   * accumulating per event regardless of what is painted.
   */
  const [state, enqueue, flush] = useBatchedState<RunActivityState>(
    () => activityStore.get(convKey) ?? emptyActivityState(),
  );

  // Latest-ref: the Tauri subscription is created once; routing always
  // reads the current options, so a conversation change needs no
  // re-subscribe (and never drops the unlisten handle).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Follow conversation switches: hydrate the accumulated tree (titles,
  // statuses, tools) instead of restarting from an empty skeleton. Flushed in
  // the same tick — a switch is navigation, not a background tick, so it must
  // never wait for the batching window.
  useEffect(() => {
    enqueue(activityStore.get(convKey) ?? emptyActivityState());
    flush();
  }, [convKey, enqueue, flush]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onAgentEvent((ev) => {
      if (disposed) return;
      const o = optsRef.current;
      // Routing key: the run envelope, and nothing else. Un-attributable
      // events are dropped here — attribution by "which panel is active" is
      // precisely the cross-conversation leak this hook must not reintroduce.
      const target = readRunEnvelope(ev).conversationId;
      if (!target) return;

      let prev = activityStore.get(target) ?? emptyActivityState();
      const rec = ev as Record<string, unknown>;
      if (
        rec.type === "agent_spawned" &&
        typeof rec.runId === "string" &&
        prev.runId !== undefined &&
        prev.runId !== rec.runId
      ) {
        prev = emptyActivityState(); // new mission in the same conversation
      }
      const next = activityReducer(prev, { kind: "event", ev } as ActivityAction);
      activityStore.set(target, next);
      // Paint rule: a panel paints its own conversation only; a background
      // conversation keeps accumulating in the store (see module header).
      // Batched: many events inside one window = one App commit; App forces
      // the pending batch out at message/run boundaries.
      if (target === o?.conversationId) enqueue(next);
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
