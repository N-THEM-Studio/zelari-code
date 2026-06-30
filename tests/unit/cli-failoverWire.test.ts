/**
 * cli-failoverWire.test.ts — Task G.1.2 + G.1.3
 *
 * Verifies that `app.tsx` correctly wires `providerFailover()` in the
 * `dispatchPrompt` path (carryover B.4.2 from v3-B). Two angles:
 *
 *  1. **Static wiring**: regex check that the file imports providerFailover
 *     and uses it inside dispatchPrompt. Catches "someone removed the
 *     wrapper" regressions.
 *
 *  2. **Behavior**: integration test that drives a real AgentHarness with
 *     a failing-primary + succeeding-fallback ProviderStreamFn pair, and
 *     asserts the failover flow shows up in the events stream.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { providerFailover } from '../../src/cli/providerFailover.js';
import { AgentHarness } from '../../src/main/core/AgentHarness.js';
import type { ProviderStreamFn, ProviderDelta } from '../../src/main/core/AgentHarness.js';

const APP_TSX_PATH = path.resolve(__dirname, '..', '..', 'src', 'cli', 'app.tsx');

describe('app.tsx wiring of providerFailover (Task G.1.2)', () => {
  it('imports providerFailover from ./providerFailover.js', () => {
    const src = readFileSync(APP_TSX_PATH, 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*\bproviderFailover\b[^}]*\}\s*from\s*['"]\.\/providerFailover\.js['"]/);
  });

  it('wraps providerStream with providerFailover() inside dispatchPrompt', () => {
    const src = readFileSync(APP_TSX_PATH, 'utf-8');
    // dispatchPrompt must reference providerFailover and the env knob.
    // We assert file-level presence + a coarse keyword check on the
    // dispatchPrompt body via `dispatchPrompt` substring window.
    const idx = src.indexOf('const dispatchPrompt');
    expect(idx).toBeGreaterThan(0);
    // Take a window from dispatchPrompt declaration through ~3000 chars
    // (dispatchPrompt body is ~100 lines in current app.tsx).
    const window = src.slice(idx, idx + 3000);
    expect(window).toMatch(/providerFailover\s*\(\s*\{/);
    expect(window).toMatch(/ANATHEMA_FAILOVER/);
  });
});

describe('providerFailover behavior end-to-end (Task G.1.3)', () => {
  function asyncGen(deltas: ProviderDelta[]): ProviderStreamFn {
    return async function* () {
      for (const d of deltas) yield d;
    };
  }

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it('primary fails transient → fallback runs; both success text surfaces', async () => {
    const primary = asyncGen([
      { kind: 'text', delta: 'partial-from-primary' },
      { kind: 'error', message: 'timeout' },
    ]);
    const fallback = asyncGen([
      { kind: 'text', delta: 'from-fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const wrapped = providerFailover({ primary, fallback });

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'minimax',
      sessionId: 'sess-failover-1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      providerStream: wrapped,
    });

    const events = (await collect(harness.run())) as Array<{ type: string; delta?: string; message?: string; reason?: string }>;
    const textDeltas = events.filter((e) => e.type === 'message_delta').map((e) => e.delta).join('');
    const errors = events.filter((e) => e.type === 'error').map((e) => e.message);

    // Both providers contribute text
    expect(textDeltas).toContain('partial-from-primary');
    expect(textDeltas).toContain('from-fallback');
    // Original error surfaces, plus the [failover] marker
    expect(errors.some((m) => m?.includes('timeout'))).toBe(true);
    expect(errors.some((m) => m?.includes('[failover]'))).toBe(true);
    // Stream terminates with agent_end — the exact reason depends on
    // whether AgentHarness counted the error as a failure (it does, so
    // we expect 'error' OR 'completed'; assert presence, not value).
    const endEvent = events.find((e) => e.type === 'agent_end');
    expect(endEvent).toBeDefined();
  });

  it('primary succeeds → fallback is NOT tried; no [failover] message', async () => {
    const primary = asyncGen([
      { kind: 'text', delta: 'all-from-primary' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const fallback = asyncGen([
      { kind: 'text', delta: 'should-not-see-this' },
    ]);
    const wrapped = providerFailover({ primary, fallback });

    const harness = new AgentHarness({
      model: 'test-model',
      provider: 'minimax',
      sessionId: 'sess-failover-2',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      providerStream: wrapped,
    });

    const events = (await collect(harness.run())) as Array<{ type: string; delta?: string; message?: string }>;
    const textDeltas = events.filter((e) => e.type === 'message_delta').map((e) => e.delta).join('');
    const errors = events.filter((e) => e.type === 'error').map((e) => e.message);

    expect(textDeltas).toContain('all-from-primary');
    expect(textDeltas).not.toContain('should-not-see-this');
    expect(errors.some((m) => m?.includes('[failover]'))).toBe(false);
  });
});
