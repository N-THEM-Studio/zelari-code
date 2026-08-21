import { describe, expect, it } from 'vitest';
import { runGauntletLoop } from '../../src/cli/gauntlet/loop.js';
import { fallbackPieces } from '../../src/cli/gauntlet/decompose.js';
import { resolveGauntletCaps } from '../../src/cli/gauntlet/policy.js';

describe('runGauntletLoop', () => {
  it('stops at max rounds when the critic always GAP', async () => {
    let builder = 0;
    let critic = 0;
    const events: string[] = [];
    const result = await runGauntletLoop({
      pieces: fallbackPieces('ship a racer'),
      caps: { maxPieces: 6, maxRounds: 3, maxParallel: 1 },
      deps: {
        sessionId: 's1',
        emit: (e) => {
          const p = (e as { progress?: { phase?: string } }).progress;
          if (p?.phase) events.push(p.phase);
        },
        runBuilder: async () => {
          builder += 1;
          return { ok: true, result: 'wrote files', toolTraceCount: 2 };
        },
        runCritic: async () => {
          critic += 1;
          return {
            ok: true,
            result: 'VERDICT: GAP\nGAP: still no tests',
            toolTraceCount: 3,
          };
        },
      },
    });
    expect(builder).toBe(3);
    expect(critic).toBe(3);
    expect(result.settled).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.pieces[0]?.verdict.kind).toBe('GAP');
    expect(result.pieces[0]?.rounds).toBe(3);
    expect(events).toContain('building');
    expect(events).toContain('critiquing');
  });

  it('stops on PASS with evidence before the cap', async () => {
    let round = 0;
    const result = await runGauntletLoop({
      pieces: fallbackPieces('goal'),
      caps: resolveGauntletCaps({}),
      deps: {
        sessionId: 's2',
        emit: () => undefined,
        runBuilder: async () => ({ ok: true, result: 'ok', toolTraceCount: 1 }),
        runCritic: async () => {
          round += 1;
          if (round < 2) {
            return { ok: true, result: 'VERDICT: GAP\nGAP: hud', toolTraceCount: 1 };
          }
          return { ok: true, result: 'VERDICT: PASS', toolTraceCount: 4 };
        },
      },
    });
    expect(round).toBe(2);
    expect(result.settled).toBe(true);
    expect(result.pieces[0]?.verdict.kind).toBe('PASS');
  });

  it('refuses PASS without critic tool evidence', async () => {
    const result = await runGauntletLoop({
      pieces: fallbackPieces('goal'),
      caps: { maxPieces: 1, maxRounds: 1, maxParallel: 1 },
      deps: {
        sessionId: 's3',
        emit: () => undefined,
        runBuilder: async () => ({ ok: true, result: 'ok', toolTraceCount: 1 }),
        runCritic: async () => ({
          ok: true,
          result: 'VERDICT: PASS',
          toolTraceCount: 0,
        }),
      },
    });
    expect(result.settled).toBe(false);
    expect(result.pieces[0]?.verdict.kind).toBe('GAP');
    expect(result.pieces[0]?.verdict.gap).toMatch(/unknown ≠ pass/i);
  });

  it('honours abort between rounds', async () => {
    const ac = new AbortController();
    let builder = 0;
    const result = await runGauntletLoop({
      pieces: fallbackPieces('goal'),
      caps: { maxPieces: 1, maxRounds: 5, maxParallel: 1 },
      deps: {
        sessionId: 's4',
        signal: ac.signal,
        emit: () => undefined,
        runBuilder: async () => {
          builder += 1;
          ac.abort();
          return { ok: true, result: 'ok', toolTraceCount: 1 };
        },
        runCritic: async () => ({
          ok: true,
          result: 'VERDICT: GAP\nGAP: x',
          toolTraceCount: 1,
        }),
      },
    });
    expect(builder).toBe(1);
    expect(result.cancelled).toBe(true);
  });

  it('runs disjoint-scope pieces in parallel', async () => {
    let inflight = 0;
    let peak = 0;
    const pieces = [
      {
        id: 'hud',
        label: 'HUD',
        prompt: 'hud',
        acceptance: [],
        scope: ['src/hud.ts'],
      },
      {
        id: 'ai',
        label: 'AI',
        prompt: 'ai',
        acceptance: [],
        scope: ['src/ai.ts'],
      },
    ];
    const result = await runGauntletLoop({
      pieces,
      caps: { maxPieces: 6, maxRounds: 1, maxParallel: 2 },
      deps: {
        sessionId: 's5',
        emit: () => undefined,
        runBuilder: async () => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await new Promise((r) => setTimeout(r, 30));
          inflight -= 1;
          return { ok: true, result: 'ok', toolTraceCount: 1 };
        },
        runCritic: async () => ({
          ok: true,
          result: 'VERDICT: PASS',
          toolTraceCount: 2,
        }),
      },
    });
    expect(peak).toBe(2);
    expect(result.settled).toBe(true);
    expect(result.pieces).toHaveLength(2);
  });

  it('records a blind A/B WINNER on the piece result', async () => {
    const result = await runGauntletLoop({
      pieces: [
        {
          id: 'hud',
          label: 'HUD',
          prompt: 'hud',
          acceptance: [],
          bar: ['gold.html', 'candidate.html'],
        },
      ],
      caps: { maxPieces: 1, maxRounds: 1, maxParallel: 1, wallClockMs: 0 },
      deps: {
        sessionId: 's6',
        emit: () => undefined,
        runBuilder: async () => ({ ok: true, result: 'ok', toolTraceCount: 1 }),
        runCritic: async () => ({
          ok: true,
          result: 'VERDICT: PASS\nWINNER: B',
          toolTraceCount: 2,
        }),
      },
    });
    expect(result.settled).toBe(true);
    expect(result.pieces[0]?.winner).toBe('B');
    expect(result.summary).toMatch(/A\/B B/);
  });

  it('stops when the wall clock expires', async () => {
    let t = 0;
    let critic = 0;
    const result = await runGauntletLoop({
      pieces: fallbackPieces('goal'),
      caps: { maxPieces: 1, maxRounds: 5, maxParallel: 1, wallClockMs: 1_000 },
      deps: {
        sessionId: 's7',
        now: () => t,
        emit: () => undefined,
        runBuilder: async () => {
          t = 5_000;
          return { ok: true, result: 'ok', toolTraceCount: 1 };
        },
        runCritic: async () => {
          critic += 1;
          return { ok: true, result: 'VERDICT: PASS', toolTraceCount: 2 };
        },
      },
    });
    expect(critic).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.settled).toBe(false);
    expect(result.summary).toMatch(/wall clock/i);
  });
});
