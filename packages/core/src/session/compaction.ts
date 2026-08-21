/**
 * session/compaction.ts — durable model-surface replacement (compact the
 * projection, never the ledger).
 *
 * A `session.compacted` event WITH `{fromSeq,toSeq}` shadows that closed
 * interval in `deriveMessages()`. Later coverings swallow earlier
 * checkpoints in their range (chaining). Events without a range stay
 * legacy: the summary is appended, nothing is shadowed.
 */

import type { SessionEventEnvelope } from './types.js';

export type CompactionStrategy = 'extractive' | 'llm';
export type CompactionCheckpointRole = 'user' | 'system';

export interface CompactedInterval {
  /** Seq of the `session.compacted` event itself (must be > toSeq). */
  seq: number;
  fromSeq: number;
  toSeq: number;
  role: CompactionCheckpointRole;
  content: string;
  strategy?: CompactionStrategy;
  sourceEventSeqs?: number[];
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function checkpointContent(data: Record<string, unknown>): string {
  const cp = data.checkpoint;
  if (cp && typeof cp === 'object') {
    const content = (cp as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  if (typeof data.summary === 'string') return data.summary;
  return '[session compacted]';
}

function checkpointRole(data: Record<string, unknown>): CompactionCheckpointRole {
  const cp = data.checkpoint;
  if (cp && typeof cp === 'object') {
    const role = (cp as { role?: unknown }).role;
    if (role === 'user' || role === 'system') return role;
  }
  return 'system';
}

function strategyOf(data: Record<string, unknown>): CompactionStrategy | undefined {
  return data.strategy === 'extractive' || data.strategy === 'llm' ? data.strategy : undefined;
}

/**
 * Parse a range-bearing compact event. Returns null for legacy `{summary}`
 * notes (no shadowing) and for malformed ranges.
 */
export function parseCompactedEvent(event: SessionEventEnvelope): CompactedInterval | null {
  if (event.kind !== 'session.compacted') return null;
  const fromSeq = asPositiveInt(event.data.fromSeq);
  const toSeq = asPositiveInt(event.data.toSeq);
  if (fromSeq === undefined || toSeq === undefined || fromSeq > toSeq) return null;
  if (event.seq <= toSeq) return null;
  const sourceRaw = event.data.sourceEventSeqs;
  const sourceEventSeqs = Array.isArray(sourceRaw)
    ? sourceRaw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    : undefined;
  return {
    seq: event.seq,
    fromSeq,
    toSeq,
    role: checkpointRole(event.data),
    content: checkpointContent(event.data),
    ...(strategyOf(event.data) ? { strategy: strategyOf(event.data) } : {}),
    ...(sourceEventSeqs && sourceEventSeqs.length > 0 ? { sourceEventSeqs } : {}),
  };
}

/**
 * Effective coverings: later compaction that contains an earlier compact
 * event's seq swallows that checkpoint (nested / chained).
 */
export function coveringCompactions(
  events: readonly SessionEventEnvelope[],
): CompactedInterval[] {
  const effective = events
    .map(parseCompactedEvent)
    .filter((c): c is CompactedInterval => c !== null)
    .map((c) => ({
      ...c,
      ...(c.sourceEventSeqs ? { sourceEventSeqs: [...c.sourceEventSeqs] } : {}),
    }))
    .sort((a, b) => a.seq - b.seq);

  // Resolve to a fixed point. When a later checkpoint covers the seq of an
  // earlier checkpoint, it inherits the earlier checkpoint's raw interval.
  // Otherwise C2=101..180 swallowing C1(seq=101, range=1..100) would expose
  // raw 1..100 again after C1 disappeared from the visible surface.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < effective.length; i++) {
      const earlier = effective[i]!;
      let target: CompactedInterval | undefined;
      for (let j = i + 1; j < effective.length; j++) {
        const later = effective[j]!;
        if (earlier.seq >= later.fromSeq && earlier.seq <= later.toSeq) {
          target = later;
        }
      }
      if (!target) continue;
      target.fromSeq = Math.min(target.fromSeq, earlier.fromSeq);
      target.toSeq = Math.max(target.toSeq, earlier.toSeq);
      if (earlier.sourceEventSeqs?.length) {
        target.sourceEventSeqs = [
          ...new Set([...(target.sourceEventSeqs ?? []), ...earlier.sourceEventSeqs]),
        ];
      }
      effective.splice(i, 1);
      changed = true;
      break;
    }
  }
  return effective;
}

export function shadowedSeqSet(coverings: readonly CompactedInterval[]): Set<number> {
  const set = new Set<number>();
  for (const c of coverings) {
    for (let s = c.fromSeq; s <= c.toSeq; s++) set.add(s);
  }
  return set;
}

export function isSeqShadowed(seq: number, coverings: readonly CompactedInterval[]): boolean {
  return coverings.some((c) => seq >= c.fromSeq && seq <= c.toSeq);
}

export * from './compactionState.js';
