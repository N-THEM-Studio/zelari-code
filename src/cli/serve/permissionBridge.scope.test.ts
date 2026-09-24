/**
 * t59/t61 (chat isolation) — scope contract of the serve permission bridge.
 *
 * Acceptance: an ask raised inside a harness session carries that session's
 * id on the wire; a `permission.respond` from ANOTHER session is rejected
 * (`session_mismatch`) and leaves the ask pending; session grants are
 * bucketed per harness session and `clearSessionPermissionGrants(sid)`
 * only drops that session's bucket. Legacy unscoped hosts keep working.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  createServePermissionBridge,
  servePermissionRespond,
} from './permissionBridge.js';
import { runWithSession } from './sessionControl.js';
import {
  clearSessionPermissionGrants,
  grantSessionTool,
  isSessionGranted,
} from '../safety/toolPermissions.js';

describe('serve permission bridge — session scoping (t59)', () => {
  const lines: string[] = [];
  const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);

  beforeEach(() => {
    lines.length = 0;
    clearSessionPermissionGrants();
  });
  afterEach(() => {
    clearSessionPermissionGrants();
  });

  it('stamps the dispatch session on permission.request and .settled', () => {
    const pending = runWithSession('sess-A', () =>
      bridge.onPermissionAsk({ tool: 'bash', category: 'execute' }),
    );
    const req = JSON.parse(lines[0]);
    expect(req.type).toBe('permission.request');
    expect(req.sessionId).toBe('sess-A');

    expect(
      servePermissionRespond(bridge, {
        requestId: req.requestId,
        decision: 'allow',
        sessionId: 'sess-A',
      }),
    ).toEqual({ accepted: true });
    expect(bridge.pendingCount()).toBe(0);

    const settled = lines.find((l) => l.includes('permission.settled'));
    expect(settled).toBeDefined();
    expect(JSON.parse(settled!).sessionId).toBe('sess-A');
    return expect(pending).resolves.toBe('allow');
  });

  it('rejects a respond from another session and keeps the ask pending', () => {
    const pending = runWithSession('sess-A', () =>
      bridge.onPermissionAsk({ tool: 'bash', category: 'execute' }),
    );
    const req = JSON.parse(lines[0]);

    const wrong = servePermissionRespond(bridge, {
      requestId: req.requestId,
      decision: 'always-tool',
      sessionId: 'sess-B',
    });
    expect(wrong.accepted).toBe(false);
    expect(wrong.reason).toContain('session_mismatch');
    expect(bridge.pendingCount()).toBe(1);

    // The owning chat can still settle it afterwards.
    expect(
      servePermissionRespond(bridge, {
        requestId: req.requestId,
        decision: 'deny',
        sessionId: 'sess-A',
      }).accepted,
    ).toBe(true);
    return expect(pending).resolves.toBe('deny');
  });

  it('legacy unscoped ask/respond still works (no sessionId on the wire)', () => {
    const pending = bridge.onPermissionAsk({ tool: 'bash', category: 'execute' });
    const req = JSON.parse(lines[0]);
    expect('sessionId' in req).toBe(false);
    expect(bridge.sessionOf(req.requestId)).toBeUndefined();

    // A scoped respond cannot hijack an unscoped ask either.
    expect(
      servePermissionRespond(bridge, {
        requestId: req.requestId,
        decision: 'allow',
        sessionId: 'sess-X',
      }).accepted,
    ).toBe(false);

    expect(
      servePermissionRespond(bridge, { requestId: req.requestId, decision: 'deny' }),
    ).toEqual({ accepted: true });
    return expect(pending).resolves.toBe('deny');
  });

  it('releaseGranted only settles asks whose session got the grant', () => {
    const pendingA = runWithSession('sess-A', () =>
      bridge.onPermissionAsk({ tool: 'bash', category: 'execute' }),
    );
    const pendingB = runWithSession('sess-B', () =>
      bridge.onPermissionAsk({ tool: 'bash', category: 'execute' }),
    );
    const idA = JSON.parse(lines[0]).requestId;
    const idB = JSON.parse(lines[1]).requestId;

    grantSessionTool('bash', 'sess-A');
    expect(bridge.releaseGranted()).toBe(1);
    expect(bridge.sessionOf(idA)).toBeUndefined();
    expect(bridge.sessionOf(idB)).toBe('sess-B');

    servePermissionRespond(bridge, {
      requestId: idB,
      decision: 'deny',
      sessionId: 'sess-B',
    });
    return Promise.all([
      expect(pendingA).resolves.toBe('allow'),
      expect(pendingB).resolves.toBe('deny'),
    ]);
  });
});

describe('tool permissions — per-session grant buckets (t61)', () => {
  beforeEach(() => clearSessionPermissionGrants());
  afterEach(() => clearSessionPermissionGrants());

  it('a grant in session A never applies to session B or the global scope', () => {
    grantSessionTool('bash', 'sess-A');
    expect(isSessionGranted('bash', [], 'sess-A')).toBe(true);
    expect(isSessionGranted('bash', [], 'sess-B')).toBe(false);
    // Unscoped lookup = global bucket (TUI): Desktop grants stay invisible.
    expect(isSessionGranted('bash', [])).toBe(false);
  });

  it('clearSessionPermissionGrants(sid) drops only that session bucket', () => {
    grantSessionTool('bash', 'sess-A');
    grantSessionTool('bash', 'sess-B');
    clearSessionPermissionGrants('sess-A');
    expect(isSessionGranted('bash', [], 'sess-A')).toBe(false);
    expect(isSessionGranted('bash', [], 'sess-B')).toBe(true);
  });
});

describe('serve permission bridge — session-routing stamp', () => {
  it('permission.request and .settled carry harnessSessionId (the Desktop routing key)', () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const pending = runWithSession('sess-R', () =>
      bridge.onPermissionAsk({ tool: 'bash', category: 'execute' }),
    );
    const req = JSON.parse(lines[0]);
    expect(req.harnessSessionId).toBe('sess-R');
    servePermissionRespond(bridge, { requestId: req.requestId, decision: 'deny', sessionId: 'sess-R' });
    const settled = JSON.parse(lines.find((l) => l.includes('permission.settled'))!);
    expect(settled.harnessSessionId).toBe('sess-R');
    return expect(pending).resolves.toBe('deny');
  });
});
