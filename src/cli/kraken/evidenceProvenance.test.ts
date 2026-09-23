/**
 * 2.1 T5 — original-tool-backed provenance (pattern A vs pattern B).
 *
 * Locks:
 * - A note matching a RAW captured tool execution anchors the EvidenceRef to
 *   a `verification.evidence` event carrying the tool output digest
 *   (observation: 'tool-result', provenance: 'tentacle-tool-capture').
 * - A note with NO matching capture falls back to the deprecated note event
 *   (observation: 'verify-report-note', provenance: 'note-fallback').
 * - Counts distinguish the two patterns.
 * - Matching is best-effort: command overlap first, then distinctive output
 *   fragments (counts like "41/41").
 */
import { describe, expect, it } from 'vitest';
import {
  anchorSelectionEvidence,
  matchNoteToToolTrace,
} from './verificationBridge.js';
import type { TentacleToolTrace } from './verifyReport.js';
import type { VerificationResult } from '@zelari/core/verification';
import type { SessionEventInput } from '@zelari/core/session';

function resultWithNote(criterionId: string, note: string): VerificationResult {
  return {
    criterionId,
    status: 'pass',
    source: 'verify-agent',
    evidence: [{ tier: 'tool-output', ref: note, capturedAt: Date.now() }],
    evaluatedAt: Date.now(),
    durationMs: 0,
  };
}

const VITEST_TRACE: TentacleToolTrace[] = [
  {
    tool: 'bash',
    callId: 'c-1',
    ok: true,
    command: 'npx vitest run src/session',
    output: 'Test Files 4 passed (4)\nTests 67 passed (67)',
    durationMs: 1200,
    endedAt: Date.now(),
  },
];

describe('matchNoteToToolTrace', () => {
  it('matches by command overlap (note cites the command)', () => {
    const m = matchNoteToToolTrace('npx vitest run src/session — 67/67 pass', VITEST_TRACE);
    expect(m?.callId).toBe('c-1');
  });

  it('matches by distinctive output fragment when the command is not cited', () => {
    const m = matchNoteToToolTrace('test suite green: 67 passed (67)', VITEST_TRACE);
    expect(m?.callId).toBe('c-1');
  });

  it('returns null when nothing overlaps', () => {
    const m = matchNoteToToolTrace('manually inspected the diff, looks fine', VITEST_TRACE);
    expect(m).toBeNull();
  });

  it('returns null on empty note or empty trace', () => {
    expect(matchNoteToToolTrace('', VITEST_TRACE)).toBeNull();
    expect(matchNoteToToolTrace('vitest 41/41', [])).toBeNull();
  });
});

describe('anchorSelectionEvidence (T5 provenance)', () => {
  function makeEmitter() {
    const events: Array<Record<string, unknown>> = [];
    let seq = 100;
    const emit = async (input: SessionEventInput) => {
      seq += 1;
      events.push({ seq, kind: input.kind, ...input.data });
      return { seq };
    };
    return { events, emit };
  }

  it('pattern A: anchors to a tool-result event with digest when the note matches a capture', async () => {
    const r = resultWithNote('check-1-vitest', 'npx vitest run src/session — all green');
    const { events, emit } = makeEmitter();
    const counts = await anchorSelectionEvidence([r], emit, VITEST_TRACE);
    expect(counts.toolResultAnchored).toBe(1);
    expect(counts.noteFallback).toBe(0);
    expect(r.evidence[0]!.seq).toBe(101);
    expect(r.evidence[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]).toMatchObject({
      observation: 'tool-result',
      provenance: 'tentacle-tool-capture',
      tool: 'bash',
      callId: 'c-1',
      ok: true,
      criterionId: 'check-1-vitest',
    });
  });

  it('pattern B (M1.3): unmatched note stays UNANCHORED — a re-emitted note is not evidence', async () => {
    const r = resultWithNote('check-1-manual', 'agent says it reviewed the code by eye');
    const { events, emit } = makeEmitter();
    const counts = await anchorSelectionEvidence([r], emit, VITEST_TRACE);
    expect(counts.toolResultAnchored).toBe(0);
    expect(counts.noteFallback).toBe(1);
    // The morsa: the note-fallback event is observability ONLY — no seq, no
    // digest on the EvidenceRef, so requireEventBackedEvidence BLOCKs.
    expect(r.evidence[0]!.seq).toBeUndefined();
    expect(r.evidence[0]!.digest).toBeUndefined();
    expect(events[0]).toMatchObject({
      observation: 'verify-report-note',
      provenance: 'note-fallback',
      anchored: false,
    });
  });

  it('no emitter → nothing anchored, policy will BLOCK (RC false-done guard intact)', async () => {
    const r = resultWithNote('check-1-vitest', 'npx vitest run src/session — all green');
    const counts = await anchorSelectionEvidence([r], undefined, VITEST_TRACE);
    expect(counts.toolResultAnchored).toBe(0);
    expect(counts.noteFallback).toBe(0);
    expect(r.evidence[0]!.seq).toBeUndefined();
  });

  it('already-anchored refs are skipped (idempotent)', async () => {
    const r = resultWithNote('check-1-vitest', 'npx vitest run src/session — all green');
    r.evidence[0]!.seq = 55;
    const { events, emit } = makeEmitter();
    const counts = await anchorSelectionEvidence([r], emit, VITEST_TRACE);
    expect(counts.toolResultAnchored + counts.noteFallback).toBe(0);
    expect(events).toHaveLength(0);
    expect(r.evidence[0]!.seq).toBe(55);
  });

  it('K5.2 (F29): un-anchorable notes emit ONE aggregate evidence.not_anchored (count + reason)', async () => {
    const r1 = resultWithNote('check-1-manual', 'agent says it reviewed the code by eye');
    const r2 = resultWithNote('check-2-manual', 'agent says it sniffed the diff by nose');
    const { events, emit } = makeEmitter();
    const counts = await anchorSelectionEvidence([r1, r2], emit, VITEST_TRACE);
    expect(counts.noteFallback).toBe(2);
    const loud = events.filter((e) => e.kind === 'evidence.not_anchored');
    expect(loud).toHaveLength(1);
    expect(loud[0]).toMatchObject({ count: 2 });
    expect(String(loud[0]!.reason)).toContain('without captured tool execution');
  });

  it('K5.2 (F29) negative: zero fallbacks → NO evidence.not_anchored', async () => {
    const r = resultWithNote('check-1-vitest', 'npx vitest run src/session — all green');
    const { events, emit } = makeEmitter();
    await anchorSelectionEvidence([r], emit, VITEST_TRACE);
    expect(events.some((e) => e.kind === 'evidence.not_anchored')).toBe(false);
  });

  it('K5.2 (F29) negative: already-anchored refs emit NO evidence.not_anchored', async () => {
    const r = resultWithNote('check-1-vitest', 'npx vitest run src/session — all green');
    r.evidence[0]!.seq = 55;
    const { events, emit } = makeEmitter();
    await anchorSelectionEvidence([r], emit, VITEST_TRACE);
    expect(events.some((e) => e.kind === 'evidence.not_anchored')).toBe(false);
  });
});
