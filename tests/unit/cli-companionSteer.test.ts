/**
 * cli-companionSteer.test.ts — t40: steer over the companion HTTP server.
 *
 * POST /v1/runs/:id/steer must route to the EXISTING live-turn steering
 * control plane (RunManager.steer → HarnessClient.steer → NDJSON
 * session.steer → RuntimeControlQueue); the HTTP layer only adds routing,
 * body validation and status mapping. Accordingly this suite boots the REAL
 * `runCompanionServe` HTTP server (loopback, explicit Bearer token → no
 * ~/.zelari-code reads/writes) with RunManager mocked at the module seam:
 *   - 201 of POST /v1/runs exposes steerUrl next to eventsUrl/cancelUrl;
 *   - steer ok → 200 with the body forwarded to RunManager.steer;
 *   - missing/blank/non-string text (and malformed JSON) → 400, not forwarded;
 *   - functional errors (unknown run) → 404, mirroring the cancel handler;
 *   - steer sits behind the same Bearer auth gate.
 * The RunManager → NDJSON chain itself is covered by
 * cli-companionRunManager.test.ts (t32c).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  steerCalls: [] as Array<{ runId: string | undefined; text: string }>,
  cancelCalls: [] as Array<string | undefined>,
  steerResult: null as
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: string }
    | null,
  cancelResult: null as { ok: true } | { ok: false; error: string } | null,
}));

vi.mock('../../src/cli/companion/runManager.js', () => {
  class FakeRunManager {
    start(args: { prompt?: string; cwd: string }) {
      return {
        ok: true as const,
        run: {
          id: 'run-1',
          status: 'running',
          mode: 'kraken',
          phase: 'build',
          cwd: args.cwd,
          createdAt: Date.now(),
          events: [],
        },
      };
    }
    getActive(): null {
      return null;
    }
    getRun(): null {
      return null;
    }
    listRecent(): unknown[] {
      return [];
    }
    subscribe(): () => void {
      return () => {};
    }
    cancel(runId?: string) {
      state.cancelCalls.push(runId);
      return state.cancelResult ?? ({ ok: true as const });
    }
    async steer(runId: string | undefined, text: string) {
      state.steerCalls.push({ runId, text });
      return state.steerResult ?? { ok: true as const, result: { queued: true } };
    }
  }
  return { RunManager: FakeRunManager };
});

import { runCompanionServe } from '../../src/cli/companion/serve.js';

const TOKEN = 't40-companion-test-token';
const PORT = 25420 + (process.pid % 2000);
const BASE = `http://127.0.0.1:${PORT}`;

let projectDir = '';
let servePromise: Promise<void> | undefined;

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`companion serve did not become healthy on ${BASE}`);
}

function post(pathname: string, raw: unknown, token: string = TOKEN): Promise<Response> {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: typeof raw === 'string' ? raw : JSON.stringify(raw),
  });
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'zelari-t40-'));
  servePromise = runCompanionServe({
    bind: '127.0.0.1',
    port: PORT,
    token: TOKEN,
    projects: [projectDir],
  });
  await waitForHealth();
}, 15_000);

afterAll(async () => {
  // Trigger the SIGTERM shutdown handler registered by runCompanionServe
  // (synthetic emit — no OS signal, safe inside the vitest worker).
  process.emit('SIGTERM', 'SIGTERM');
  await servePromise?.catch(() => {});
});

describe('companion serve — POST /v1/runs/:id/steer (t40)', () => {
  beforeEach(() => {
    state.steerCalls.length = 0;
    state.cancelCalls.length = 0;
    state.steerResult = null;
    state.cancelResult = null;
  });

  it('POST /v1/runs 201 exposes steerUrl next to eventsUrl/cancelUrl', async () => {
    const res = await post('/v1/runs', { prompt: 'do the thing' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      eventsUrl: '/v1/runs/run-1/events',
      cancelUrl: '/v1/runs/run-1/cancel',
      steerUrl: '/v1/runs/run-1/steer',
    });
  });

  it('steer ok → 200, text forwarded to RunManager.steer with the path runId', async () => {
    const res = await post('/v1/runs/run-1/steer', { text: 'make it blue' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      steered: 'run-1',
      result: { queued: true },
    });
    expect(state.steerCalls).toEqual([{ runId: 'run-1', text: 'make it blue' }]);
  });

  it('steer with missing/blank/non-string text or bad JSON → 400, never forwarded', async () => {
    const cases: Array<{ raw: unknown; error: string }> = [
      { raw: {}, error: 'text is required' },
      { raw: { text: '' }, error: 'text is required' },
      { raw: { text: '   ' }, error: 'text is required' },
      { raw: { text: 42 }, error: 'text is required' },
      { raw: 'not-json', error: 'invalid JSON body' },
    ];
    for (const { raw, error } of cases) {
      const res = await post('/v1/runs/run-1/steer', raw);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error });
    }
    expect(state.steerCalls).toEqual([]);
  });

  it('steer on unknown run → 404, mirroring the cancel handler', async () => {
    state.steerResult = { ok: false, error: 'No active run' };
    const res = await post('/v1/runs/does-not-exist/steer', { text: 'hello' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'No active run' });
    expect(state.steerCalls).toEqual([
      { runId: 'does-not-exist', text: 'hello' },
    ]);

    // Reference: cancel maps the same functional error to 404.
    state.cancelResult = { ok: false, error: 'No active run' };
    const cancelRes = await post('/v1/runs/does-not-exist/cancel', {});
    expect(cancelRes.status).toBe(404);
    expect(await cancelRes.json()).toEqual({ ok: false, error: 'No active run' });
  });

  it('cancel ok still → 200 (regression: same handler area)', async () => {
    const res = await post('/v1/runs/run-1/cancel', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: 'run-1' });
    expect(state.cancelCalls).toContain('run-1');
  });

  it('steer without bearer token → 401 (same auth gate)', async () => {
    const res = await fetch(`${BASE}/v1/runs/run-1/steer`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(state.steerCalls).toEqual([]);
  });
});
