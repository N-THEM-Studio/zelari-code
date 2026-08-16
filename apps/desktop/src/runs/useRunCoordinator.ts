import { useCallback, useReducer } from "react";
import {
  emptyRunRegistry,
  markResultSeen,
  runDispatchFailed,
  runFinished,
  runRequested,
  runStarted,
} from "./reducer";
import type { RunRegistryState } from "./types";
import { getRunForConversation, isConversationRunning } from "./selectors";

type Action =
  | { type: "requested"; conversationId: string; cwd?: string }
  | {
      type: "started";
      run: { runId: string; conversationId: string; cwd?: string };
    }
  | { type: "dispatchFailed"; conversationId: string }
  | {
      type: "finished";
      payload: {
        runId: string;
        conversationId: string;
        exitCode: number;
        cancelled: boolean;
      };
      activeConversationId?: string | null;
    }
  | { type: "markSeen"; conversationId: string };

function reducer(state: RunRegistryState, action: Action): RunRegistryState {
  switch (action.type) {
    case "requested":
      return runRequested(state, action.conversationId, action.cwd);
    case "started":
      return runStarted(state, action.run);
    case "dispatchFailed":
      return runDispatchFailed(state, action.conversationId);
    case "finished":
      return runFinished(state, action.payload, action.activeConversationId);
    case "markSeen":
      return markResultSeen(state, action.conversationId);
  }
}

/**
 * Frontend RunRegistry. Owns run lifecycle only — prompt dispatch stays in
 * App.tsx (`runTask`), which reports back via `runStarted` /
 * `runDispatchFailed`. The Rust host enforces the real concurrency policy
 * (max 1 active run per cwd, MAX_PARALLEL_RUNS global); this registry is
 * the UI mirror used for composer state and sidebar badges.
 */
export function useRunCoordinator() {
  const [state, dispatch] = useReducer(reducer, emptyRunRegistry);

  const request = useCallback((conversationId: string, cwd?: string) => {
    dispatch({ type: "requested", conversationId, cwd });
  }, []);

  const started = useCallback(
    (run: { runId: string; conversationId: string; cwd?: string }) => {
      dispatch({ type: "started", run });
    },
    [],
  );

  const dispatchFailed = useCallback((conversationId: string) => {
    dispatch({ type: "dispatchFailed", conversationId });
  }, []);

  const finished = useCallback(
    (
      payload: {
        runId: string;
        conversationId: string;
        exitCode: number;
        cancelled: boolean;
      },
      activeConversationId?: string | null,
    ) => {
      dispatch({ type: "finished", payload, activeConversationId });
    },
    [],
  );

  const markSeen = useCallback((conversationId: string) => {
    dispatch({ type: "markSeen", conversationId });
  }, []);

  return {
    state,
    request,
    started,
    dispatchFailed,
    finished,
    markSeen,
    isRunning: (conversationId?: string | null) =>
      isConversationRunning(state, conversationId),
    getRun: (conversationId?: string | null) =>
      getRunForConversation(state, conversationId),
  };
}

export type RunCoordinator = ReturnType<typeof useRunCoordinator>;
