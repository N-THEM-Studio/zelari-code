/**
 * ControlBridge — wire the headless stdin control plane to a
 * RuntimeControlQueue with protocol-v2 acks (Frontier PHASE 2, §22–§35).
 *
 * Lifecycle:
 *   attachControlPlane()  → starts reading stdin, emits nothing yet
 *   (run in flight)       → valid events: control_accepted + enqueue
 *                           drain by SteeringObserver: control_applied
 *   finalize()            → late steers converted to follow-ups (§28),
 *                           remaining follow-ups drained + acked,
 *                           returns their texts for the host to re-run
 *   dispose()             → detach stdin listener
 *
 * Acks honor §24: accepted ≠ applied. Desktop must wait for
 * `control_applied` before marking a control as delivered to the agent.
 */
import type { RuntimeControlQueue } from '@zelari/core/runtime';
import type { ControlEvent, SteerControlEvent } from '@zelari/core/runtime';
import { parseControlLine, startControlReader } from './controlReader.js';
import {
  controlAcceptedEvent,
  controlAppliedEvent,
  controlRejectedEvent,
  type ControlAckEvent,
} from './protocol.js';

export type EmitFn = (event: ControlAckEvent | unknown) => void;

export interface ControlPlaneHandle {
  /** Detach the stdin reader (does not touch the queue). */
  dispose(): void;
  /**
   * Run-boundary end: convert leftover steers into follow-ups (§28),
   * ack everything still pending, and return the follow-up texts in
   * arrival order so the host can chain them as next tasks.
   */
  finalize(): string[];
  /** True once finalize() has run (late steers then queue as follow-ups). */
  readonly finalized: boolean;
}

export interface ControlPlaneOptions {
  input: NodeJS.ReadableStream;
  queue: RuntimeControlQueue;
  emit: EmitFn;
  /** Cooperative cancel hook (host maps it onto harness.cancel()). */
  onCancel?: (reason?: string) => void;
}

const APPLIED_BOUNDARY: Record<string, string> = {
  steer: 'turn-end',
  follow_up: 'run-end',
  cancel: 'cancel',
};

export function attachControlPlane(opts: ControlPlaneOptions): ControlPlaneHandle {
  const { input, queue, emit, onCancel } = opts;
  let finalized = false;

  // §24: emit control_applied exactly when the runtime consumes events —
  // the queue's onDrained hook fires inside SteeringObserver.drainSteers().
  queue.onDrained = (events: ControlEvent[]) => {
    for (const event of events) {
      emit(
        controlAppliedEvent(
          event.id,
          event.type,
          APPLIED_BOUNDARY[event.type] ?? 'unknown',
        ),
      );
    }
    const cancels = events.filter((e) => e.type === 'cancel');
    if (cancels.length > 0 && onCancel) {
      const last = cancels[cancels.length - 1];
      onCancel(last.type === 'cancel' ? (last as { reason?: string }).reason : undefined);
    }
  };

  const disposeReader = startControlReader(input, (line) => {
    const outcome = parseControlLine(line);
    if (outcome === null) return; // blank line
    if (!outcome.ok) {
      emit(controlRejectedEvent(outcome.id, outcome.reason));
      return;
    }
    const event = outcome.event;
    if (event.type === 'pause' || event.type === 'resume') {
      // Carried by the ControlEvent union (§23) but not yet mapped onto
      // runtime semantics — reject explicitly instead of silent drop.
      emit(
        controlRejectedEvent(event.id, `${event.type} is not supported yet`),
      );
      return;
    }
    if (finalized) {
      // Run already over (§28): a steer this late can still matter, keep it
      // as a follow-up so the host chains it as the next task.
      if (event.type === 'steer') {
        const converted = toFollowUp(event);
        queue.enqueue(converted);
        emit(controlAppliedEvent(event.id, 'steer', 'converted-to-follow-up'));
        emit(controlAcceptedEvent(converted.id, 'follow_up'));
      } else if (event.type === 'follow_up') {
        queue.enqueue(event);
        emit(controlAcceptedEvent(event.id, 'follow_up'));
      } else {
        emit(controlRejectedEvent(event.id, 'run already finished'));
      }
      return;
    }
    queue.enqueue(event);
    emit(controlAcceptedEvent(event.id, event.type));
  });

  return {
    dispose() {
      disposeReader();
      queue.onDrained = undefined;
    },
    finalize(): string[] {
      finalized = true;
      // §28: steers that never reached a boundary become follow-ups.
      const lateSteers = queue.drainSteers();
      for (const steer of lateSteers) {
        queue.enqueue(toFollowUp(steer));
        emit(controlAppliedEvent(steer.id, 'steer', 'converted-to-follow-up'));
      }
      const followUps = queue.drainFollowUps();
      for (const followUp of followUps) {
        emit(controlAppliedEvent(followUp.id, 'follow_up', 'run-end'));
      }
      return followUps.map((f) => f.text);
    },
    get finalized() {
      return finalized;
    },
  };
}

function toFollowUp(steer: SteerControlEvent): ControlEvent {
  return {
    type: 'follow_up',
    id: `fu-${steer.id}`,
    text: steer.text,
    ts: steer.ts,
  };
}
