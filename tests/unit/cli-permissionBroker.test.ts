/**
 * cli-permissionBroker.test.ts — v1.30.0 permission broker coverage.
 *
 * Exercises the JSON-lines socket protocol (OpenMausBot pattern):
 *   - permission allow/deny round-trip with injected handlers,
 *   - question round-trip,
 *   - missing handler → deny (never hang),
 *   - per-request timeout → deny,
 *   - client-side `requestBrokerAsk` rejections when the broker is absent.
 *
 * Uses real local sockets (unix socket on POSIX, named pipe on Windows).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import {
  startPermissionBroker,
  requestBrokerAsk,
  type PermissionBrokerHandle,
} from '../../src/cli/mcp/permissionBroker.js';

function makeSocketPath(): string {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\zelari-perm-test-${suffix}`;
  }
  return join(tmpdir(), `zelari-perm-test-${suffix}.sock`);
}

const handles: PermissionBrokerHandle[] = [];
async function withBroker(
  socketPath: string,
  handlers: Parameters<typeof startPermissionBroker>[1],
  opts?: { requestTimeoutMs?: number },
): Promise<PermissionBrokerHandle> {
  const h = await startPermissionBroker(socketPath, handlers, opts);
  handles.push(h);
  return h;
}

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.stop();
  }
});

describe('startPermissionBroker — permission asks', () => {
  it('round-trips an allow decision', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onPermission: async (req) => {
        expect(req.tool).toBe('Bash');
        expect(req.input).toMatchObject({ command: 'ls' });
        return { behavior: 'allow' };
      },
    });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: { command: 'ls' },
    });
    expect(res).toEqual({ behavior: 'allow' });
  });

  it('round-trips a deny decision with the handler message', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onPermission: async () => ({
        behavior: 'deny',
        message: 'blocked by policy',
      }),
    });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: {},
    });
    expect(res).toEqual({ behavior: 'deny', message: 'blocked by policy' });
  });

  it('denies when no permission handler is registered (never hangs)', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {});
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: {},
    });
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('no approval handler');
  });

  it('answers deny when the handler throws (broker stays alive)', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onPermission: async () => {
        throw new Error('boom');
      },
    });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: {},
    });
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('boom');

    // Broker still serves the next request.
    const again = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: {},
    });
    expect(again.behavior).toBe('deny');
  });

  it('answers deny on per-request timeout', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onPermission: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ behavior: 'allow' }), 5_000);
        }),
    }, { requestTimeoutMs: 120 });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'permission',
      tool: 'Bash',
      input: {},
    });
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('timed out');
  });
});

describe('startPermissionBroker — question asks', () => {
  it('round-trips a text answer', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onQuestion: async (req) => {
        expect(req.question).toContain('which?');
        expect(req.choices).toEqual(['A', 'B']);
        return { behavior: 'allow', answer: 'A' };
      },
    });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'question',
      question: 'which?',
      choices: ['A', 'B'],
    });
    expect(res).toEqual({ behavior: 'allow', answer: 'A' });
  });

  it('denies when the question handler returns null (cancelled)', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {
      onQuestion: async () => null,
    });
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'question',
      question: 'which?',
      choices: ['A', 'B'],
    });
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('cancelled');
  });

  it('denies when no question handler is registered', async () => {
    const socketPath = makeSocketPath();
    await withBroker(socketPath, {});
    const res = await requestBrokerAsk(socketPath, {
      t: 'ask',
      id: randomUUID(),
      kind: 'question',
      question: 'which?',
      choices: ['A', 'B'],
    });
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('no interactive answer');
  });
});

describe('requestBrokerAsk — client-side failure modes', () => {
  it('rejects quickly when no broker is listening', async () => {
    const socketPath = makeSocketPath();
    await expect(
      requestBrokerAsk(
        socketPath,
        { t: 'ask', id: randomUUID(), kind: 'permission', tool: 'Bash', input: {} },
        { connectTimeoutMs: 150 },
      ),
    ).rejects.toThrow(/unavailable|connect/i);
  });

  it('rejects on request timeout when the broker never answers', async () => {
    // A raw listener that accepts but never replies. On Windows named pipes
    // an unread connection keeps server.close() pending forever, so the
    // server must resume/destroy its sockets before closing.
    const socketPath = makeSocketPath();
    const accepted = new Set<Socket>();
    const server = createServer((sock) => {
      accepted.add(sock);
      sock.resume();
      sock.on('close', () => accepted.delete(sock));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        requestBrokerAsk(
          socketPath,
          { t: 'ask', id: randomUUID(), kind: 'permission', tool: 'Bash', input: {} },
          { requestTimeoutMs: 120, connectTimeoutMs: 500 },
        ),
      ).rejects.toThrow(/timed out/);
    } finally {
      for (const s of accepted) s.destroy();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stop() closes the listener so new connects fail', async () => {
    const socketPath = makeSocketPath();
    const h = await withBroker(socketPath, {
      onPermission: async () => ({ behavior: 'allow' }),
    });
    await h.stop();
    await expect(
      requestBrokerAsk(
        socketPath,
        { t: 'ask', id: randomUUID(), kind: 'permission', tool: 'Bash', input: {} },
        { connectTimeoutMs: 150 },
      ),
    ).rejects.toThrow();
  });
});
