/**
 * Headless control-plane protocol v2 (Frontier upgrade PHASE 2, §35).
 *
 * Event factories for the bidirectional headless channel:
 *   stdin  ← ControlEvent NDJSON (see controlReader.ts)
 *   stdout → BrainEvent NDJSON (acks below + protocol_info handshake)
 *
 * Desktop must gate Steer UI on `protocol_info.version >= 2` and on
 * `control_accepted` (never assume stdin writes took effect, §24).
 */

/** Bump when the stdout event set or stdin contract changes. */
export const HEADLESS_PROTOCOL_VERSION = 2;

/** Capabilities advertised by this CLI build (§35). */
export const HEADLESS_PROTOCOL_CAPABILITIES = [
  'stdin-control',
  'steer',
  'follow_up',
  'cancel',
] as const;

export function protocolInfoEvent(): {
  type: 'protocol_info';
  version: number;
  capabilities: readonly string[];
  ts: number;
} {
  return {
    type: 'protocol_info',
    version: HEADLESS_PROTOCOL_VERSION,
    capabilities: HEADLESS_PROTOCOL_CAPABILITIES,
    ts: Date.now(),
  };
}

export interface ControlAckEvent {
  type: 'control_accepted' | 'control_applied' | 'control_rejected';
  controlId: string;
  controlType?: string;
  boundary?: string;
  reason?: string;
  ts: number;
}

export function controlAcceptedEvent(
  controlId: string,
  controlType: string,
): ControlAckEvent {
  return {
    type: 'control_accepted',
    controlId,
    controlType,
    ts: Date.now(),
  };
}

export function controlAppliedEvent(
  controlId: string,
  controlType: string,
  boundary: string,
): ControlAckEvent {
  return {
    type: 'control_applied',
    controlId,
    controlType,
    boundary,
    ts: Date.now(),
  };
}

export function controlRejectedEvent(
  controlId: string,
  reason: string,
): ControlAckEvent {
  return {
    type: 'control_rejected',
    controlId,
    reason,
    ts: Date.now(),
  };
}
