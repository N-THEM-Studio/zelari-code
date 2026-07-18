/**
 * cli-failoverWire.test.ts — Task G.1.2 + G.1.3
 *
 * Verifies that the dispatch path correctly wires `providerFailover()`.
 * After the v0.4.2 app-split, this lives in `src/cli/hooks/useChatTurn.ts`
 * (was previously inline in app.tsx). The static-wiring regex now checks
 * the hook file; we additionally verify app.tsx imports the hook so the
 * wiring is reachable from the UI.
 *
 *  1. **Static wiring**: regex check that useChatTurn.ts imports
 *     providerFailover and uses it in the dispatch path.
 *  2. **Behavior**: integration test that drives a real AgentHarness with
 *     a failing-primary + succeeding-fallback ProviderStreamFn pair, and
 *     asserts the failover flow shows up in the events stream.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { providerFailover } from '../../src/cli/providerFailover.js';
import { AgentHarness } from '@zelari/core/harness';
import type { ProviderStreamFn, ProviderDelta } from '@zelari/core/harness';

const APP_TSX_PATH = path.resolve(__dirname, '..', '..', 'src', 'cli', 'app.tsx');
const USE_CHAT_TURN_PATH = path.resolve(__dirname, '..', '..', 'src', 'cli', 'hooks', 'useChatTurn.ts');

describe('useChatTurn.ts wiring of providerFailover (Task G.1.2)', () => {
  it('imports providerFailover from ../providerFailover.js', () => {
    const src = readFileSync(USE_CHAT_TURN_PATH, 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*\bproviderFailover\b[^}]*\}\s*from\s*['"][^'"]*providerFailover\.js['"]/);
  });

  it('wraps providerStream with providerFailover() inside dispatchPrompt', () => {
    const src = readFileSync(USE_CHAT_TURN_PATH, 'utf-8');
    // dispatchPrompt must reference providerFailover and the env knob.
    const idx = src.indexOf('const dispatchPrompt');
    expect(idx).toBeGreaterThan(0);
    // Window must cover ask_user wiring that precedes failover in dispatchPrompt.
    const window = src.slice(idx, idx + 16000);
    expect(window).toMatch(/providerFailover\s*\(\s*\{/);
    expect(window).toMatch(/ANATHEMA_FAILOVER/);
  });

  it('app.tsx imports useChatTurn so the wiring is reachable', () => {
    const src = readFileSync(APP_TSX_PATH, 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*\buseChatTurn\b[^}]*\}\s*from\s*['"][^'"]*hooks\/useChatTurn\.js['"]/);
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
