/**
 * session/modelSurface.ts — the ONLY path from session events to model history.
 *
 * `isModelSurfaceEvent` decides what counts as model-visible; `deriveMessages`
 * projects surface events into a provider-neutral message list. Range-bearing
 * `session.compacted` events replace `[fromSeq, toSeq]` (ledger unchanged).
 * The CLI maps these onto its provider-specific request format — nothing else
 * may invent model-visible history (ADR-0016 invariant: model-visible ⟺ logged).
 *
 * 2.6 (doc §10.2): LATEST-ONLY kinds. `resource.snapshot` is model-surface
 * but only its LAST event projects — earlier snapshots stay in the ledger
 * (state) without flooding the context. Every event kind may opt into this
 * projection; today it is exactly {'resource.snapshot'}.
 */

import type { SessionEventEnvelope, SessionEventKind } from './types.js';
import { coveringCompactions, isSeqShadowed } from './compaction.js';

/** Event kinds that (may) feed the model input. Everything else is state. */
export const MODEL_SURFACE_KINDS: ReadonlySet<SessionEventKind> = new Set([
  'user.message',
  'assistant.message',
  'tool.call',
  'tool.result',
  'session.compacted',
  // 2.6: budget awareness for the model (latest-only projection below).
  'resource.snapshot',
]);

/**
 * Surface kinds projected LATEST-ONLY: the highest-seq event of the kind
 * becomes one system message; earlier ones remain in the log (state).
 */
export const LATEST_ONLY_SURFACE_KINDS: ReadonlySet<SessionEventKind> = new Set(['resource.snapshot']);

export function isModelSurfaceEvent(event: { kind: string }): boolean {
  return MODEL_SURFACE_KINDS.has(event.kind as SessionEventKind);
}

/** Highest seq per latest-only kind — the sole event of that kind that projects. */
export function latestSurfaceSeqByKind(
  events: readonly SessionEventEnvelope[],
): Map<SessionEventKind, number> {
  const latest = new Map<SessionEventKind, number>();
  for (const e of events) {
    if (LATEST_ONLY_SURFACE_KINDS.has(e.kind) && !isSeqShadowed(e.seq, coveringCompactions(events))) {
      latest.set(e.kind, e.seq);
    }
  }
  return latest;
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
  /** Closed raw interval represented by a durable compact checkpoint. */
  compactedFromSeq?: number;
  compactedToSeq?: number;
  sourceEventSeqs?: number[];
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Human/model-readable RESOURCE STATUS block (doc §10.3) from a snapshot
 * payload. Pure — used by deriveMessages and by the CLI emitter tests.
 */
export function formatResourceSnapshot(data: Record<string, unknown>): string {
  const used = asNumber(data.toolCallsUsed) ?? 0;
  const remaining = asNumber(data.toolCallsRemaining) ?? 0;
  const limit = asNumber(data.toolCallsLimit) ?? used + remaining;
  const lines = [
    'RESOURCE STATUS',
    `Tool calls: ${used} / ${limit}`,
    `Remaining: ${remaining}`,
  ];
  const overrun = asNumber(data.overrun);
  if (overrun !== undefined && overrun > 0) lines.push(`Overrun: ${overrun}`);
  const wall = asNumber(data.wallMsRemaining);
  if (wall !== undefined) lines.push(`Wall clock remaining: ${Math.max(0, Math.round(wall / 1000))}s`);
  lines.push(`Verification reserve: ${asNumber(data.verificationReserve) ?? 0}`);
  lines.push(`Repair reserve: ${asNumber(data.repairReserve) ?? 0}`);
  if (typeof data.stage === 'string') lines.push(`Stage: ${data.stage}`);
  if (typeof data.pressure === 'string') lines.push(`Pressure: ${data.pressure}`);
  return lines.join('\n');
}

/**
 * Project surface events into the neutral model history. Deterministic.
 *
 * Range-bearing `session.compacted` events replace `[fromSeq, toSeq]` with
 * the checkpoint (durable shadowing). Compact events without a range stay
 * additive (legacy `{summary}` append). Latest-only kinds project exactly
 * their last event (see LATEST_ONLY_SURFACE_KINDS).
 */
export function deriveMessages(
  events: readonly SessionEventEnvelope[],
  options: DeriveMessagesOptions = {},
): DerivedMessage[] {
  const coverings = coveringCompactions(events);
  const orderedCoverings = [...coverings].sort((a, b) => a.fromSeq - b.fromSeq || a.seq - b.seq);
  const compactBySeq = new Map(coverings.map((c) => [c.seq, c]));
  const latestOfKind = latestSurfaceSeqByKind(events);
  const messages: DerivedMessage[] = [];
  let nextCheckpoint = 0;
  const pushCheckpoint = (compact: (typeof orderedCoverings)[number]): void => {
    messages.push({
      role: compact.role,
      content: compact.content,
      seq: compact.seq,
      compactedFromSeq: compact.fromSeq,
      compactedToSeq: compact.toSeq,
      ...(compact.sourceEventSeqs ? { sourceEventSeqs: compact.sourceEventSeqs } : {}),
    });
  };
  const pushDueCheckpoints = (seq: number): void => {
    while (nextCheckpoint < orderedCoverings.length && orderedCoverings[nextCheckpoint]!.fromSeq <= seq) {
      pushCheckpoint(orderedCoverings[nextCheckpoint]!);
      nextCheckpoint += 1;
    }
  };
  for (const e of events) {
    pushDueCheckpoints(e.seq);
    if (compactBySeq.has(e.seq)) continue;
    if (isSeqShadowed(e.seq, coverings)) continue;
    if (!isModelSurfaceEvent(e)) continue;
    // Latest-only projection: skip superseded snapshots of the same kind.
    if (LATEST_ONLY_SURFACE_KINDS.has(e.kind) && latestOfKind.get(e.kind) !== e.seq) continue;
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
      case 'resource.snapshot':
        messages.push({
          role: 'system',
          content: formatResourceSnapshot(d),
          seq: e.seq,
        });
        break;
    }
  }
  pushDueCheckpoints(Number.POSITIVE_INFINITY);
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
