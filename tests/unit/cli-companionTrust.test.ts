/**
 * cli-companionTrust.test.ts — t66: full-fs browsing + desktop trust gate.
 *
 * Two layers, same loopback harness as the sibling companion suites:
 *   1. resolveProjectPath (config.ts): full-fs flags an existing absolute
 *      directory OUTSIDE the allowlist as trusted:false; without full-fs the
 *      same key is an allowlist error.
 *   2. the REAL runCompanionServe HTTP server with RunManager mocked at the
 *      module seam: GET /v1/fs lists a dir outside the allowlist in full
 *      mode, POST /v1/runs on that cwd parks awaitingTrust (start receives
 *      the gate and never launches), POST /v1/trust approve/deny drives
 *      releaseTrust/denyTrust, and allowlist mode keeps the t63 400/403.
 *
 * ZELARI_HOME points at a throwaway dir so the approve path's companion.json
 * write never touches the developer's real ~/.zelari-code.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ZELARI_HOME = mkdtempSync(join(tmpdir(), 'zelari-t66-home-'));

import { resolveProjectPath } from '../../src/cli/companion/config.js';

const state = vi.hoisted(() => ({
  startCalls: [] as Array<{
    args: Record<string, unknown>;
    gate?: { awaitingTrust?: boolean };
  }>,
  pending: null as { runId: string; path: string } | null,
  releaseCalls: 0,
  denyCalls: [] as string[],
}));

vi.mock('../../src/cli/companion/runManager.js', () => {
  class FakeRunManager {
    start(args: Record<string, unknown>, gate?: { awaitingTrust?: boolean }) {
      state.startCalls.push({ args, gate });
      if (gate?.awaitingTrust) {
        state.pending = { runId: 'run-park', path: String(args.cwd) };
        return {
          ok: true as const,
          awaitingTrust: true as const,
          run: {
            id: 'run-park',
            status: 'awaiting_trust',
            mode: 'kraken',
            phase: 'build',
            cwd: String(args.cwd),
            createdAt: Date.now(),
            events: [],
          },
        };
      }
      return {
        ok: true as const,
        run: {
          id: 'run-1',
          status: 'running',
          mode: 'kraken',
          phase: 'build',
          cwd: String(args.cwd),
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
    cancel() {
      return { ok: true as const };
    }
    async steer() {
      return { ok: true as const, result: {} };
    }
    async permissionRespond() {
      return { ok: true as const, result: {} };
    }
    async askUserRespond() {
      return { ok: true as const, result: {} };
    }
    pendingTrust() {
      return state.pending;
    }
    releaseTrust() {
      state.releaseCalls++;
      state.pending = null;
      return { ok: true as const };
    }
    denyTrust(reason: string) {
      state.denyCalls.push(reason);
      state.pending = null;
      return { ok: true as const };
    }
  }
  return { RunManager: FakeRunManager };
});

import { runCompanionServe } from '../../src/cli/companion/serve.js';

const TOKEN_FULL = 't66-trust-full-token';
const TOKEN_ALLOW = 't66-trust-allow-token';
const PORT_FULL = 29_000 + (process.pid % 800);
const PORT_ALLOW = PORT_FULL + 400;
const BASE_FULL = `http://127.0.0.1:${PORT_FULL}`;
const BASE_ALLOW = `http://127.0.0.1:${PORT_ALLOW}`;

let root = '';
let outside = '';
let fullServe: Promise<void> | undefined;
let allowServe: Promise<void> | undefined;

async function waitForHealth(base: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`companion serve did not become healthy on ${base}`);
}

function get(base: string, token: string, pathname: string): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function post(
  base: string,
  token: string,
  pathname: string,
  raw: unknown,
): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(raw),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'zelari-t66-allow-'));
  outside = mkdtempSync(join(tmpdir(), 'zelari-t66-outside-'));
  fullServe = runCompanionServe({
    bind: '127.0.0.1',
    port: PORT_FULL,
    token: TOKEN_FULL,
    projects: [root],
  });
  allowServe = runCompanionServe({
    bind: '127.0.0.1',
    port: PORT_ALLOW,
    token: TOKEN_ALLOW,
    projects: [root],
    fsMode: 'allowlist',
  });
  await Promise.all([waitForHealth(BASE_FULL), waitForHealth(BASE_ALLOW)]);
}, 20_000);

afterAll(async () => {
  process.emit('SIGTERM', 'SIGTERM');
  await Promise.all([fullServe?.catch(() => {}), allowServe?.catch(() => {})]);
});

describe('resolveProjectPath — full-fs (unit)', () => {
  const projects = () => [{ id: 'p', name: 'p', path: root }];

  it('full-fs flags an existing dir outside the allowlist as trusted:false', () => {
    const res = resolveProjectPath(projects(), outside, { fullFs: true });
    expect(res.ok).toBe(true);
    expect((res as { trusted: boolean }).trusted).toBe(false);
  });

  it('without full-fs the same outside key is an allowlist error', () => {
    const res = resolveProjectPath(projects(), outside, {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('not in allowlist');
  });

  it('an allowlisted path stays trusted in full-fs', () => {
    const res = resolveProjectPath(projects(), root, { fullFs: true });
    expect(res.ok).toBe(true);
    expect((res as { trusted: boolean }).trusted).toBe(true);
  });
});

describe('companion serve — full fs + trust gate', () => {
  beforeEach(() => {
    state.startCalls.length = 0;
    state.pending = null;
    state.releaseCalls = 0;
    state.denyCalls.length = 0;
  });

  it('GET /v1/fs with no path lists PC roots (full mode)', async () => {
    const res = await get(BASE_FULL, TOKEN_FULL, '/v1/fs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roots: unknown[]; entries: unknown[] };
    expect(body.roots.length).toBeGreaterThan(0);
    expect(body.entries).toEqual([]);
  });

  it('GET /v1/fs lists a directory outside the allowlist (full mode)', async () => {
    const res = await get(
      BASE_FULL,
      TOKEN_FULL,
      `/v1/fs?path=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(outside);
  });

  it('POST /v1/runs on an unlisted cwd parks awaitingTrust (start gets the gate)', async () => {
    const res = await post(BASE_FULL, TOKEN_FULL, '/v1/runs', {
      prompt: 'go',
      cwd: outside,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      awaitingTrust?: boolean;
      run: { status: string };
    };
    expect(body.awaitingTrust).toBe(true);
    expect(body.run.status).toBe('awaiting_trust');
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]!.gate).toEqual({ awaitingTrust: true });
  });

  it('POST /v1/runs on an allowlisted cwd does not park', async () => {
    const res = await post(BASE_FULL, TOKEN_FULL, '/v1/runs', {
      prompt: 'go',
      cwd: root,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { awaitingTrust?: boolean };
    expect(body.awaitingTrust).toBeUndefined();
    expect(state.startCalls[0]!.gate).toBeUndefined();
  });

  it('GET /v1/trust/pending exposes the parked run', async () => {
    await post(BASE_FULL, TOKEN_FULL, '/v1/runs', { prompt: 'go', cwd: outside });
    const res = await get(BASE_FULL, TOKEN_FULL, '/v1/trust/pending');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: { runId: string } | null };
    expect(body.pending?.runId).toBe('run-park');
  });

  it('POST /v1/trust approve releases the parked run', async () => {
    // Approve persists the folder into the serve's allowlist — use a dir no
    // other test depends on so the mutation cannot leak across cases.
    const approved = mkdtempSync(join(tmpdir(), 'zelari-t66-approve-'));
    await post(BASE_FULL, TOKEN_FULL, '/v1/runs', { prompt: 'go', cwd: approved });
    const res = await post(BASE_FULL, TOKEN_FULL, '/v1/trust', {
      runId: 'run-park',
      approve: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, approved: 'run-park' });
    expect(state.releaseCalls).toBe(1);
  });

  it('POST /v1/trust deny cancels the parked run', async () => {
    await post(BASE_FULL, TOKEN_FULL, '/v1/runs', { prompt: 'go', cwd: outside });
    const res = await post(BASE_FULL, TOKEN_FULL, '/v1/trust', {
      runId: 'run-park',
      approve: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, denied: 'run-park' });
    expect(state.denyCalls).toHaveLength(1);
  });

  it('POST /v1/trust with an unknown runId → 409', async () => {
    await post(BASE_FULL, TOKEN_FULL, '/v1/runs', { prompt: 'go', cwd: outside });
    const res = await post(BASE_FULL, TOKEN_FULL, '/v1/trust', {
      runId: 'other',
      approve: true,
    });
    expect(res.status).toBe(409);
    expect(state.releaseCalls).toBe(0);
  });

  it('trust endpoints sit behind the bearer gate', async () => {
    const res = await fetch(`${BASE_FULL}/v1/trust/pending`);
    expect(res.status).toBe(401);
  });
});

describe('companion serve — allowlist mode keeps the t63 sandbox', () => {
  beforeEach(() => {
    state.startCalls.length = 0;
  });

  it('POST /v1/runs on an unlisted cwd → 400 (never forwarded)', async () => {
    const res = await post(BASE_ALLOW, TOKEN_ALLOW, '/v1/runs', {
      prompt: 'go',
      cwd: outside,
    });
    expect(res.status).toBe(400);
    expect(state.startCalls).toHaveLength(0);
  });

  it('GET /v1/fs on a dir outside the allowlist → 403', async () => {
    const res = await get(
      BASE_ALLOW,
      TOKEN_ALLOW,
      `/v1/fs?path=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(403);
  });
});
