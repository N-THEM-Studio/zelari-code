/**
 * How the Desktop composer should treat Enter while a run is live.
 *
 * Steer applies at the next tool-loop boundary (session.steer).
 * Queue waits for run-finished and becomes the next user turn.
 */
export type LiveSendKind = "steer" | "queue";

export function classifyLiveSend(opts: {
  running: boolean;
  steerSupported: boolean;
  alreadySteeredThisRun: boolean;
}): LiveSendKind | "new_turn" {
  if (!opts.running) return "new_turn";
  if (opts.steerSupported && !opts.alreadySteeredThisRun) return "steer";
  return "queue";
}

/**
 * After a run ends, the oldest queued follow-up should dispatch as the next
 * user turn — unless the user has typed a *different* composer draft (they
 * are editing; leave the chip). A draft that equals the queued text is the
 * idle prefill, not an edit.
 */
export function shouldAutoSendFollowUp(opts: {
  queued: string | undefined | null;
  draft: string;
  wasCancelled: boolean;
}): string | null {
  if (opts.wasCancelled) return null;
  const queued = opts.queued?.trim() ?? "";
  if (!queued) return null;
  const typed = opts.draft.trim();
  if (typed && typed !== queued) return null;
  return queued;
}
