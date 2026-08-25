/**
 * Runtime control client — Desktop side of the headless control plane
 * (Frontier plan §22/§30–§35).
 *
 * The Rust bridge (`send_control` in src-tauri) writes one NDJSON
 * ControlEvent to the running CLI child's stdin. The CLI acknowledges via
 * `control_accepted` / `control_applied` / `control_rejected` BrainEvents;
 * "sent" is NOT "steered" until `control_applied` arrives (§24).
 */

/** Minimal mirror of the CLI's ControlEvent union (src/cli/headless/protocol.ts). */
export type ControlEventKind = 'steer' | 'follow_up' | 'cancel' | 'pause' | 'resume';

export interface ProtocolInfoEvent {
  type: 'protocol_info';
  version: number;
  capabilities?: string[];
}

export interface OutboundControlEvent {
  type: ControlEventKind;
  id: string;
  ts: number;
  /** steer / follow_up payload. */
  text?: string;
  reason?: string;
}

let seq = 0;

/** Build an outbound control event with a unique id + timestamp. */
export function controlEvent(
  type: ControlEventKind,
  payload: { text?: string; reason?: string } = {},
): OutboundControlEvent {
  seq += 1;
  return {
    type,
    id: `ctl-${Date.now().toString(36)}-${seq}`,
    ts: Date.now(),
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
  };
}

/**
 * Capability gate (§35): an old CLI emits no `protocol_info`, so the Desktop
 * must disable Steer and hint at updating. `pause`/`resume` are never
 * advertised by protocol v2.
 */
export function supportsControl(info: ProtocolInfoEvent | null | undefined, kind: ControlEventKind): boolean {
  if (!info || info.type !== 'protocol_info') return false;
  if (info.version < 2) return false;
  const caps = info.capabilities ?? [];
  if (kind === 'pause' || kind === 'resume') return false;
  if (kind === 'steer') return caps.includes('steer');
  if (kind === 'follow_up') return caps.includes('follow_up');
  if (kind === 'cancel') return caps.includes('cancel');
  return false;
}

/** Send one control event to a running headless child (Tauri invoke). */
export async function sendControl(runId: string, event: OutboundControlEvent): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('send_control', { runId, event });
}
