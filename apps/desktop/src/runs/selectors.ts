import type { RunRegistryState, RunRuntime } from "./types";

/** A conversation blocks its composer while a run is starting/running. */
export function isConversationRunning(
  state: RunRegistryState,
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return false;
  const runId = state.runIdByConversation[conversationId];
  if (!runId) return false;
  const s = state.runsById[runId]?.status;
  return s === "starting" || s === "running";
}

export function getRunForConversation(
  state: RunRegistryState,
  conversationId: string | null | undefined,
): RunRuntime | undefined {
  if (!conversationId) return undefined;
  const runId = state.runIdByConversation[conversationId];
  return runId ? state.runsById[runId] : undefined;
}

export function activeRunCount(state: RunRegistryState): number {
  return Object.values(state.runsById).filter(
    (r) => r.status === "starting" || r.status === "running",
  ).length;
}

/** conversationId → unseen completion badge (for the sidebar). */
export function unseenResultsByConversation(
  state: RunRegistryState,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of Object.values(state.runsById)) {
    if (r.unseenResult) out[r.conversationId] = true;
  }
  return out;
}
