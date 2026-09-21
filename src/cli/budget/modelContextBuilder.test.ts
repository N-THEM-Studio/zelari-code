import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@zelari/core/harness';
import { buildModelContext, assembleRequestTail } from './modelContextBuilder.js';

const snapshot = {
  toolCallsLimit: 40,
  toolCallsUsed: 3,
  toolCallsRemaining: 37,
  verificationReserve: 6,
  repairReserve: 4,
  stage: 'implement',
  pressure: 'normal',
};

function countStatus(history: readonly AgentMessage[]): number {
  return history.filter(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('RESOURCE STATUS'),
  ).length;
}

describe('modelContextBuilder ephemeral RESOURCE STATUS tail', () => {
  it('returns one request-only tail without mutating persistent history', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      resourceSnapshot: snapshot,
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(1);
  });

  it('strips a legacy persisted status and replaces it with the current tail', async () => {
    const result = await buildModelContext({
      fallbackHistory: [
        { role: 'user', content: 'fix the bug' },
        {
          role: 'system',
          content:
            'RESOURCE STATUS\nTool calls: 3 / 40\nRemaining: 37\nVerification reserve: 6\nRepair reserve: 4\nStage: implement\nPressure: normal',
        },
      ],
      phase: 'build',
      resourceSnapshot: snapshot,
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(1);
    expect(result.requestTail[0]!.content).toContain('Tool calls: 3 / 40');
  });

  it('no snapshot input → no status block at all', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
    });
    expect(countStatus(result.history)).toBe(0);
    expect(countStatus(result.requestTail)).toBe(0);
  });
});

describe('modelContextBuilder budget projection seam (T4, ADR-0032)', () => {
  it('projects the final budget onto the optional note handle — occupancy+policy, no memory-side fields', async () => {
    const notes: Array<{ text: string; data?: Record<string, unknown> }> = [];
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      budgetNoteHandle: { note: (text, data) => void notes.push({ text, data }) },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('context.projection');
    expect(notes[0]!.data).toMatchObject({ subject: 'context.projection' });
    const data = notes[0]!.data as { occupancy?: number; policy?: string };
    expect(typeof data.occupancy).toBe('number');
    expect(['ok', 'warn', 'compact', 'hard']).toContain(data.policy);
    // Budget-side payload must NOT carry the memory-path counters.
    expect(notes[0]!.data).not.toHaveProperty('contextChars');
    expect(notes[0]!.data).not.toHaveProperty('returnedCount');
    // The projection reflects the FINAL budget the caller received.
    expect(data.occupancy).toBe(result.budget.occupancy);
  });

  it('no handle → no note, no crash (backward compatible)', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
    });
    expect(result.budget.contextLimit).toBeGreaterThan(0);
  });
});

describe('modelContextBuilder volatile one-pager tail (S4)', () => {
  const pager: AgentMessage[] = [
    { role: 'system', content: 'WORKING SET\n## Open loops\n- [ ] t1: do it (pending)' },
  ];

  it('places the one-pager in requestTail, never in rolling history', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      volatileOnePager: pager,
    });
    expect(result.requestTail.some((m) => m.content.startsWith('WORKING SET'))).toBe(true);
    expect(result.history.some((m) => m.content.startsWith('WORKING SET'))).toBe(false);
  });

  it('concatenates the one-pager AFTER RESOURCE STATUS', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      resourceSnapshot: snapshot,
      volatileOnePager: pager,
    });
    expect(result.requestTail[0]!.content.startsWith('RESOURCE STATUS')).toBe(true);
    expect(result.requestTail.at(-1)!.content.startsWith('WORKING SET')).toBe(true);
  });

  it('the one-pager raises the measured token estimate vs identical input without it', async () => {
    const base = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
    });
    const withPager = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      volatileOnePager: pager,
    });
    expect(withPager.budget.estimatedHistoryTokens).toBeGreaterThan(
      base.budget.estimatedHistoryTokens,
    );
    expect(withPager.budget.occupancy).toBeGreaterThanOrEqual(base.budget.occupancy);
  });

  it('an empty volatileOnePager is identical to omitting it', async () => {
    const omitted = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
    });
    const empty = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'hello' }],
      phase: 'build',
      volatileOnePager: [],
    });
    expect(empty.budget.occupancy).toBe(omitted.budget.occupancy);
    expect(empty.requestTail.length).toBe(omitted.requestTail.length);
  });
});

describe('modelContextBuilder request-tail assembler (t150)', () => {
  // The marker can only reach the tail through assembleRequestTail: the snapshot
  // is rendered as the RESOURCE STATUS `Stage:` line and never enters history.
  const MARKER = 'T150_ASSEMBLER_MARKER';
  const markerSnapshot = { ...snapshot, stage: MARKER };
  const markerPager: AgentMessage[] = [
    { role: 'system', content: 'WORKING SET\n## Open loops\n- [ ] keep the tail volatile' },
  ];
  const hasMarker = (
    messages: readonly AgentMessage[],
    needle: string = MARKER,
  ): boolean =>
    messages.some(
      (m) => typeof m.content === 'string' && m.content.includes(needle),
    );

  it('resolves the one literal: RESOURCE STATUS first, one-pager after', () => {
    const tail = assembleRequestTail(markerSnapshot, markerPager);
    expect(tail[0]!.content.startsWith('RESOURCE STATUS')).toBe(true);
    expect(tail.at(-1)!.content.startsWith('WORKING SET')).toBe(true);
    expect(hasMarker(tail)).toBe(true);
  });

  it('is the builder tail verbatim: marker in requestTail, never in history', async () => {
    const result = await buildModelContext({
      fallbackHistory: [{ role: 'user', content: 'fix the bug' }],
      phase: 'build',
      resourceSnapshot: markerSnapshot,
      volatileOnePager: markerPager,
    });
    expect(result.requestTail).toEqual(
      assembleRequestTail(markerSnapshot, markerPager),
    );
    expect(hasMarker(result.requestTail)).toBe(true);
    expect(hasMarker(result.history)).toBe(false);
  });

  it('host-style arrow call reads the FRESH snapshot (nothing frozen)', () => {
    // Same shape as useChatTurn ~941 and runOneTurn ~652: assembler + send-time
    // snapshot, so a status change after the build is still visible.
    const arrowTail = () =>
      assembleRequestTail({ ...snapshot, stage: 'T150_FRESH_STAGE' }, markerPager);
    expect(hasMarker(arrowTail(), 'T150_FRESH_STAGE')).toBe(true);
    expect(hasMarker(arrowTail())).toBe(false);
  });

  it('both host arrows call the assembler instead of spreading the two literals', () => {
    const hosts = [
      new URL('../hooks/useChatTurn.ts', import.meta.url),
      new URL('../headless/runOneTurn.ts', import.meta.url),
    ];
    for (const host of hosts) {
      const source = readFileSync(host, 'utf8');
      const at = source.indexOf('requestTail: () =>');
      expect(at).toBeGreaterThan(-1);
      const body = source.slice(at, at + 220);
      expect(body).toContain('assembleRequestTail(');
      expect(body).not.toContain('resourceStatusTail(');
    }
  });
});
