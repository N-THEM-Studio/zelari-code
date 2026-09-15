/**
 * cli-companionFs.test.ts — t63: sandboxed folder browsing (GET /v1/fs).
 *
 * Same harness as cli-companionSteer.test.ts: the REAL `runCompanionServe`
 * HTTP server (loopback, explicit Bearer token → no ~/.zelari-code
 * reads/writes) with RunManager mocked at the module seam (the fs route
 * never touches it, but the constructor must not spawn).
 *
 * Contract under test:
 *   - no `path` param → 200 with the allowlist roots and empty entries;
 *   - `path` under a root → 200 with DIRECTORIES only (dotted excluded,
 *     sorted), native `join` paths, `parent` in normalized form (null at
 *     the root itself);
 *   - `..` traversal and any path outside the allowlisted roots → 403;
 *   - existing-root prefix but missing directory → 404;
 *   - the route sits behind the same Bearer auth gate as every /v1/*.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/cli/companion/runManager.js', () => {
  class FakeRunManager {
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
  }
  return { RunManager: FakeRunManager };
});

import { runCompanionServe } from '../../src/cli/companion/serve.js';

const TOKEN = 't63-companion-fs-token';
const PORT = 26420 + (process.pid % 2000);
const BASE = `http://127.0.0.1:${PORT}`;

let root = '';
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

function get(pathname: string, token: string = TOKEN): Promise<Response> {
  return fetch(`${BASE}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'zelari-t63-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'alpha', 'nested'));
  writeFileSync(join(root, 'file.txt'), 'not a directory');
  servePromise = runCompanionServe({
    bind: '127.0.0.1',
    port: PORT,
    token: TOKEN,
    projects: [root],
    // t66: this suite asserts the t63 sandbox contract (roots = allowlist,
    // path outside → 403); full-fs browsing + trust parking is covered by
    // cli-companionTrust.test.ts.
    fsMode: 'allowlist',
  });
  await waitForHealth();
}, 15_000);

afterAll(async () => {
  process.emit('SIGTERM', 'SIGTERM');
  await servePromise?.catch(() => {});
});

describe('companion serve — GET /v1/fs (t63)', () => {
  it('no path → 200 with the allowlist roots and empty entries', async () => {
    const res = await get('/v1/fs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      roots: Array<{ id: string; path: string }>;
      entries: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.entries).toEqual([]);
    expect(body.roots.map((r) => r.path)).toEqual([root]);
  });

  it('path = root → directories only, sorted, dotted excluded, parent null', async () => {
    const res = await get(`/v1/fs?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string; dir: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(root);
    expect(body.parent).toBeNull();
    expect(body.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(body.entries.every((e) => e.dir)).toBe(true);
    expect(body.entries.map((e) => e.path)).toEqual([
      join(root, 'alpha'),
      join(root, 'beta'),
    ]);
  });

  it('subdirectory → 200 with normalized parent pointing back at the root', async () => {
    const res = await get(`/v1/fs?path=${encodeURIComponent(join(root, 'alpha'))}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent: string | null;
      entries: Array<{ name: string }>;
    };
    expect(body.entries.map((e) => e.name)).toEqual(['nested']);
    expect(body.parent).toBe(root.replace(/\\/g, '/'));
  });

  it('`..` traversal and paths outside the allowlisted roots → 403', async () => {
    const traversal = await get(`/v1/fs?path=${encodeURIComponent(join(root, '..', '..'))}`);
    expect(traversal.status).toBe(403);
    expect(await traversal.json()).toEqual({ ok: false, error: 'path outside allowed roots' });

    const outside = await get(`/v1/fs?path=${encodeURIComponent(tmpdir())}`);
    expect(outside.status).toBe(403);
    expect(await outside.json()).toEqual({ ok: false, error: 'path outside allowed roots' });
  });

  it('missing directory under a root → 404', async () => {
    const res = await get(`/v1/fs?path=${encodeURIComponent(join(root, 'nope'))}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'path not found' });
  });

  it('without bearer token → 401 (same /v1/* auth gate)', async () => {
    const res = await fetch(`${BASE}/v1/fs`);
    expect(res.status).toBe(401);
  });
});
