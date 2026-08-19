/**
 * session/modelSurface.ts — the ONLY path from session events to model history.
 *
 * `isModelSurfaceEvent` decides what counts as model-visible; `deriveMessages`
 * projects surface events into a provider-neutral message list. The CLI maps
 * these onto its provider-specific request format — nothing else may invent
 * model-visible history (ADR-0016 invariant: model-visible ⟺ logged).
 */

import type { SessionEventEnvelope, SessionEventKind } from './types.js';

/** Event kinds that (may) feed the model input. Everything else is state. */
export const MODEL_SURFACE_KINDS: ReadonlySet<SessionEventKind> = new Set([
  'user.message',
  'assistant.message',
  'tool.call',
  'tool.result',
  'session.compacted',
]);

export function isModelSurfaceEvent(event: { kind: string }): boolean {
  return MODEL_SURFACE_KINDS.has(event.kind as SessionEventKind);
}

/** Provider-neutral derived message with provenance (source event seq). */
export interface DerivedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Present for tool results (and tool calls when includeToolCalls). */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Seq of the source envelope — provenance for audit/replay. */
  seq: number;
}

export interface DeriveMessagesOptions {
  /**
   * Emit tool.call events as assistant messages (JSON-encoded args). Default
   * false: the neutral history pairs calls via tool.result only; providers
   * that need explicit call blocks build them from pairToolCalls().
   */
  includeToolCalls?: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Project surface events into the neutral model history. Deterministic. */
export function deriveMessages(
  events: readonly SessionEventEnvelope[],
  options: DeriveMessagesOptions = {},
): DerivedMessage[] {
  const messages: DerivedMessage[] = [];
  for (const e of events) {
    if (!isModelSurfaceEvent(e)) continue;
    const d = e.data;
    switch (e.kind) {
      case 'user.message':
        messages.push({ role: 'user', content: String(d.text ?? ''), seq: e.seq });
        break;
      case 'assistant.message':
        messages.push({
          role: 'assistant',
          content: String(d.text ?? ''),
          seq: e.seq,
        });
        break;
      case 'tool.call':
        if (options.includeToolCalls) {
          messages.push({
            role: 'assistant',
            content: JSON.stringify({ tool: d.tool, args: d.args ?? {} }),
            toolCallId: asString(d.callId),
            toolName: asString(d.tool),
            seq: e.seq,
          });
        }
        break;
      case 'tool.result':
        messages.push({
          role: 'tool',
          content: String(d.output ?? ''),
          toolCallId: asString(d.callId),
          toolName: asString(d.tool),
          isError: d.ok === false,
          seq: e.seq,
        });
        break;
      case 'session.compacted':
        messages.push({
          role: 'system',
          content: String(d.summary ?? '[session compacted]'),
          seq: e.seq,
        });
        break;
    }
  }
  return messages;
}

/** A tool call paired with its result (when both exist in the log). */
export interface ToolCallPair {
  call: SessionEventEnvelope;
  result?: SessionEventEnvelope;
}

/** Pair tool.call events with the matching tool.result by callId, in order. */
export function pairToolCalls(events: readonly SessionEventEnvelope[]): ToolCallPair[] {
  const pending = new Map<string, ToolCallPair>();
  const ordered: ToolCallPair[] = [];
  for (const e of events) {
    if (e.kind === 'tool.call') {
      const callId = typeof e.data.callId === 'string' ? e.data.callId : `seq:${e.seq}`;
      const pair: ToolCallPair = { call: e };
      ordered.push(pair);
      pending.set(callId, pair);
    } else if (e.kind === 'tool.result') {
      if (typeof e.data.callId === 'string') {
        const pair = pending.get(e.data.callId);
        if (pair) {
          pair.result = e;
          pending.delete(e.data.callId);
        }
      }
    }
  }
  return ordered;
}
