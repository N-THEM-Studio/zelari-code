import type { RunRegistryState, RunRuntime } from "./types";
import { MAX_RETAINED_FINISHED_RUNS } from "./types";

export const emptyRunRegistry: RunRegistryState = {
  runsById: {},
  runIdByConversation: {},
};

/** Optimistic placeholder dispatched before `run_task` resolves the runId. */
export function runRequested(
  state: RunRegistryState,
  conversationId: string,
  cwd?: string,
): RunRegistryState {
  const placeholderId = `pending:${conversationId}`;
  const run: RunRuntime = {
    runId: placeholderId,
    conversationId,
    cwd,
    status: "starting",
    startedAt: Date.now(),
  };
  return {
    runsById: { ...state.runsById, [placeholderId]: run },
    runIdByConversation: {
      ...state.runIdByConversation,
      [conversationId]: placeholderId,
    },
  };
}

/** Replace the placeholder with the real run id returned by `run_task`. */
export function runStarted(
  state: RunRegistryState,
  run: { runId: string; conversationId: string; cwd?: string },
): RunRegistryState {
  const placeholderId = `pending:${run.conversationId}`;
  const prev = state.runsById[placeholderId];
  const next: RunRuntime = {
    runId: run.runId,
    conversationId: run.conversationId,
    cwd: run.cwd ?? prev?.cwd,
    status: "running",
    startedAt: prev?.startedAt ?? Date.now(),
  };
  const runsById = { ...state.runsById, [run.runId]: next };
  delete runsById[placeholderId];
  return {
    runsById,
    runIdByConversation: {
      ...state.runIdByConversation,
      [run.conversationId]: run.runId,
    },
  };
}

/** `run_task` invoke failed (policy rejection, spawn error, …). */
export function runDispatchFailed(
  state: RunRegistryState,
  conversationId: string,
): RunRegistryState {
  const placeholderId = `pending:${conversationId}`;
  const runsById = { ...state.runsById };
  delete runsById[placeholderId];
  const runIdByConversation = { ...state.runIdByConversation };
  if (runIdByConversation[conversationId] === placeholderId) {
    delete runIdByConversation[conversationId];
  }
  return { runsById, runIdByConversation };
}

export function runFinished(
  state: RunRegistryState,
  payload: {
    runId: string;
    conversationId: string;
    exitCode: number;
    cancelled: boolean;
  },
  activeConversationId: string | null | undefined,
): RunRegistryState {
  const prev = state.runsById[payload.runId];
  const status =
    payload.cancelled ? "cancelled"
    : payload.exitCode === 0 ? "finished"
    : "error";
  const run: RunRuntime = {
    runId: payload.runId,
    conversationId: payload.conversationId,
    cwd: prev?.cwd,
    status,
    startedAt: prev?.startedAt ?? Date.now(),
    finishedAt: Date.now(),
    exitCode: payload.exitCode,
    // Background completion stays flagged until the user opens that chat.
    unseenResult: payload.conversationId !== activeConversationId,
  };
  const runIdByConversation = { ...state.runIdByConversation };
  if (runIdByConversation[payload.conversationId] === payload.runId) {
    delete runIdByConversation[payload.conversationId];
  }
  const runsById = { ...state.runsById, [payload.runId]: run };
  return {
    runsById: retainRecent(runsById, payload.runId),
    runIdByConversation,
  };
}

function retainRecent(
  runsById: Record<string, RunRuntime>,
  keepRunId: string,
): Record<string, RunRuntime> {
  const finished = Object.values(runsById)
    .filter((r) => r.finishedAt != null && r.runId !== keepRunId)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  if (finished.length <= MAX_RETAINED_FINISHED_RUNS) return runsById;
  const drop = new Set(
    finished.slice(MAX_RETAINED_FINISHED_RUNS).map((r) => r.runId),
  );
  const out: Record<string, RunRuntime> = {};
  for (const [id, r] of Object.entries(runsById)) {
    if (!drop.has(id)) out[id] = r;
  }
  return out;
}

/** Clear the "✓ unseen completion" badge of one conversation. */
export function markResultSeen(
  state: RunRegistryState,
  conversationId: string,
): RunRegistryState {
  const runId = state.runIdByConversation[conversationId];
  const run = runId ? state.runsById[runId] : undefined;
  const finished = Object.values(state.runsById).find(
    (r) => r.conversationId === conversationId && r.unseenResult,
  );
  const target = finished ?? (run?.unseenResult ? run : undefined);
  if (!target) return state;
  return {
    ...state,
    runsById: {
      ...state.runsById,
      [target.runId]: { ...target, unseenResult: false },
    },
  };
}
