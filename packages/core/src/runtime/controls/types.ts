/**
 * Runtime control plane — ControlEvent contracts (Frontier upgrade, PHASE 2).
 *
 * Typed events an external controller (headless stdin bridge, Desktop, tests)
 * can enqueue while a run is in flight. Steers/follow-ups are consumed by the
 * SteeringObserver at safe turn boundaries; cancel/pause/resume are carried
 * as data so higher layers can map them onto cooperative cancellation.
 */

export interface SteerControlEvent {
  type: 'steer';
  id: string;
  text: string;
  ts: number;
  /** Reserved for future per-agent targeting; v1 always lands on the lead. */
  target?: 'lead';
}

export interface FollowUpControlEvent {
  type: 'follow_up';
  id: string;
  text: string;
  ts: number;
}

export interface CancelControlEvent {
  type: 'cancel';
  id: string;
  reason?: string;
  ts: number;
}

export interface PauseControlEvent {
  type: 'pause';
  id: string;
  ts: number;
}

export interface ResumeControlEvent {
  type: 'resume';
  id: string;
  ts: number;
}

export type ControlEvent =
  | SteerControlEvent
  | FollowUpControlEvent
  | CancelControlEvent
  | PauseControlEvent
  | ResumeControlEvent;

export function isSteerControlEvent(
  event: ControlEvent,
): event is SteerControlEvent {
  return event.type === 'steer';
}

export function isFollowUpControlEvent(
  event: ControlEvent,
): event is FollowUpControlEvent {
  return event.type === 'follow_up';
}

export function isCancelControlEvent(
  event: ControlEvent,
): event is CancelControlEvent {
  return event.type === 'cancel';
}
