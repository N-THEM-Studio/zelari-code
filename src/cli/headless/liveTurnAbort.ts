/**
 * Serve-harness + stdin cancel surface for hosts that are not runOneTurn
 * (council, zelari mission). Desktop Stop sends session.cancel; without a
 * live registration the server answers already_finished and the run continues.
 */
import { RuntimeControlQueue } from '@zelari/core/runtime';
import { registerLiveTurnControl } from '../serve/sessionControl.js';
import { attachControlPlane, type ControlPlaneHandle } from './controlBridge.js';
import { controlAppliedEvent, protocolInfoEvent } from './protocol.js';
import { emitEvent } from '../headless.js';

export interface HeadlessLiveCancel {
  readonly signal: AbortSignal;
  /** Cooperative cancel. Idempotent; always returns true once armed. */
  cancel(): boolean;
  dispose(): void;
}

/**
 * AbortController + session.cancel registration (serve-harness) or stdin
 * control plane (plain --headless JSON). Register as early as the turn
 * starts so Stop during context build is not already_finished.
 */
export function attachHeadlessLiveCancel(opts?: {
  output?: string;
}): HeadlessLiveCancel {
  const abort = new AbortController();
  const controlQueue = new RuntimeControlQueue();
  const cancel = (): boolean => {
    if (!abort.signal.aborted) abort.abort();
    return true;
  };

  const controlPlane: ControlPlaneHandle | undefined =
    opts?.output === 'json' &&
    process.stdin.isTTY !== true &&
    process.env.ZELARI_SERVE_HARNESS !== '1'
      ? (() => {
          emitEvent(protocolInfoEvent());
          return attachControlPlane({
            input: process.stdin,
            queue: controlQueue,
            emit: emitEvent,
            onCancel: () => {
              cancel();
            },
          });
        })()
      : undefined;

  const unregister =
    process.env.ZELARI_SERVE_HARNESS === '1'
      ? registerLiveTurnControl({
          queue: controlQueue,
          cancel,
        })
      : undefined;

  if (unregister) {
    const appliedBoundary: Record<string, string> = {
      steer: 'turn-end',
      follow_up: 'run-end',
      cancel: 'cancel',
    };
    controlQueue.onDrained = (events) => {
      for (const event of events) {
        emitEvent(
          controlAppliedEvent(
            event.id,
            event.type,
            appliedBoundary[event.type] ?? 'unknown',
          ),
        );
      }
    };
  }

  return {
    signal: abort.signal,
    cancel,
    dispose() {
      controlPlane?.finalize();
      controlPlane?.dispose();
      unregister?.();
    },
  };
}
