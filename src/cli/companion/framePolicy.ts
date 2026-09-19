/**
 * companion/framePolicy — fail-loudly frame-type policy for the serve +
 * companion display pipeline (OpenHarness post-mortem).
 *
 * The failure mode this closes: an emitter starts producing a frame `type`
 * that nobody added to the display allowlist. Nothing crashes — the clients
 * quietly drop the frame (or render it raw), and the feature looks "shipped"
 * while the phone/desktop never sees it. Silent loss is the worst outcome, so
 * the mismatch is made FATAL at serve startup instead: a process that cannot
 * display what it emits must not accept clients.
 *
 * Two lists, deliberately separate:
 *
 *   EMITTED_FRAME_TYPES            — what the code can actually put on the
 *                                    wire (grounded in the emitters: the
 *                                    harness protocol frames, the permission /
 *                                    ask-user bridges, the companion run
 *                                    manager, and the BrainEvents forwarded
 *                                    verbatim to companion clients).
 *   COMPANION_DISPLAY_FRAME_TYPES  — the display policy: every frame type the
 *                                    companion surface is allowed to consume.
 *
 * `assertFramePolicyComplete` is the gate. Extending the emitted vocabulary
 * therefore requires a deliberate second edit (the allowlist); forgetting it
 * fails the boot with the exact type names, never a silent drop.
 *
 * Zero runtime deps: the emitters own the writes, this module only mirrors
 * their vocabulary as literals (each group names the file it came from).
 */

/**
 * Every frame `type` the serve/ and companion/ emitters can produce.
 *
 * Keep this honest: it is the code's claim about its own output. When an
 * emitter gains a new literal, add it here AND to
 * COMPANION_DISPLAY_FRAME_TYPES in the same commit — the startup assert
 * enforces the rest.
 */
export const EMITTED_FRAME_TYPES: readonly string[] = [
  // -- harness stdio protocol (serve/harnessServer.ts + headless/protocol.ts)
  'protocol_info',
  'control_accepted',
  'control_applied',
  'control_rejected',
  // -- interactive bridges (serve/permissionBridge.ts, serve/askUserBridge.ts):
  //    the `type` written on the wire for each request/settlement pair.
  'permission.request',
  'permission.settled',
  'ask_user.request',
  'ask_user.settled',
  // -- companion run wrapper (companion/runManager.ts + companion/serve.ts)
  'trust.pending',
  'trust.settled',
  'log',
  'error',
  'run_finished',
  // -- BrainEvents forwarded verbatim to companion clients (runManager.ts
  //    re-emits whatever the harness transport hands it; the companion SSE
  //    pipes those frames straight to the phone/desktop).
  'agent_start',
  'agent_end',
  'agent_spawned',
  'agent_status',
  'agent_tool',
  'agent_ended',
  'message_start',
  'message_delta',
  'message_end',
  'thinking_delta',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'session_compacted',
  'member_cost',
  'council_mode',
  'task_update',
  'task_snapshot',
  'kraken_progress',
  'kraken_metrics',
  'context_metrics',
];

/**
 * Display policy: the frame types companion clients render. Today it mirrors
 * the emitted vocabulary one-for-one (that is why the boot gate passes); it is
 * a SEPARATE list on purpose so that adding an emitted frame stays a conscious
 * policy decision, and so that dropping a policy entry fails the boot too
 * instead of silently blinding the display.
 */
export const COMPANION_DISPLAY_FRAME_TYPES: readonly string[] = [
  ...EMITTED_FRAME_TYPES,
];

/** Same policy as a set (the shape the assert consumes). */
export const COMPANION_DISPLAY_FRAME_ALLOWLIST: ReadonlySet<string> = new Set(
  COMPANION_DISPLAY_FRAME_TYPES,
);

/**
 * Throw when any emitted frame type is missing from the display allowlist.
 * The message names EVERY offending type (de-duplicated, sorted) plus the file
 * that owns the policy, so the fix is mechanical.
 */
export function assertFramePolicyComplete(
  emittedTypes: readonly string[],
  allowlist: ReadonlySet<string>,
): void {
  const missing = [...new Set(emittedTypes)].filter((t) => !allowlist.has(t)).sort();
  if (missing.length === 0) return;
  throw new Error(
    `[frame-policy] ${missing.length} emitted frame type(s) missing from the companion ` +
      `display allowlist: ${missing.join(', ')}. Add them to ` +
      `COMPANION_DISPLAY_FRAME_TYPES in src/cli/companion/framePolicy.ts (or stop ` +
      `emitting them) — a frame outside the allowlist is silently dropped by ` +
      `companion clients (OpenHarness post-mortem).`,
  );
}

/**
 * Gate the REAL pair. Called by the serve entry before any client can connect,
 * so drift is fatal at startup rather than invisible at runtime.
 */
export function assertCompanionFramePolicy(): void {
  assertFramePolicyComplete(EMITTED_FRAME_TYPES, COMPANION_DISPLAY_FRAME_ALLOWLIST);
}
