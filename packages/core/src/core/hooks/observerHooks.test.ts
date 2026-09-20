/**
 * observerHooks.test.ts — WS5 (t137): the four OBSERVER events
 * (`PermissionRequest`, `SubagentStart`, `SubagentEnd`, `Notification`).
 *
 * Acceptance pinned here:
 *  1. a registered hook receives the STRUCTURED payload of each event;
 *  2. an observer is a SUBSCRIPTION: a slow, crashing or non-2xx handler never
 *     blocks the caller (bounded by its own timeout) and never produces a
 *     verdict — the decision it replies with is discarded;
 *  3. fail-open / fail-closed are UNCHANGED: they govern the v1.32 gate events
 *     only (asserted at the end of this file against runPreToolUse).
 *
 * HTTP hooks are used instead of spawned processes: the whole file stays
 * hermetic, cross-platform and fast, and the request BODY is the payload under
 * test (no quoting of shell one-liners).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LifecycleHookRunner } from './lifecycleHookRunner.js';
import {
  hookMatches,
  isObserverEvent,
  OBSERVER_HOOK_EVENTS,
  summarizeHookArgs,
  type AnyHookPayload,
  type HookDefinition,
} from './types.js';

/** What the fake endpoint does when a hook fires. */
type Behavior = 'allow' | 'deny' | 'http500' | 'hang';

interface Received {
  event: string;
  body: AnyHookPayload;
}

let server: Server;
let url: string;
const received: Received[] = [];
let behavior: Behavior = 'allow';
let hangTimers: NodeJS.Timeout[] = [];

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d: Buffer) => {
        raw += d.toString();
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as AnyHookPayload;
        received.push({ event: String(body.event), body });
        if (behavior === 'http500') {
          res.statusCode = 500;
          res.end('boom');
          return;
        }
        if (behavior === 'hang') {
          // Never answers within the hook's own timeout.
          hangTimers.push(setTimeout(() => res.end('{"decision":"allow"}'), 5000));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          behavior === 'deny'
            ? JSON.stringify({ decision: 'deny', reason: 'observer cannot block' })
            : JSON.stringify({ decision: 'allow' }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
    });
  });
}

function observerRunner(events: HookDefinition['match']['events'], extra: Partial<HookDefinition> = {}) {
  const logs: string[] = [];
  const runner = new LifecycleHookRunner({ logger: (m) => logs.push(m) });
  runner.addHook({
    name: 'observer',
    match: { tools: ['*'], events },
    url,
    timeoutMs: 300,
    ...extra,
  });
  return { runner, logs };
}

beforeEach(async () => {
  received.length = 0;
  behavior = 'allow';
  url = await startServer();
});

afterEach(async () => {
  for (const t of hangTimers) clearTimeout(t);
  hangTimers = [];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('observer events deliver a STRUCTURED payload (acceptance 1)', () => {
  it('PermissionRequest carries tool, categories, effect, matched rule and a bounded argsSummary', async () => {
    const { runner } = observerRunner(['PermissionRequest']);
    const result = await runner.runPermissionRequest(
      {
        tool: 'write_file',
        categories: ['write'],
        effect: 'deny',
        matchedRuleId: 'no-secrets',
        source: 'project',
        reason: 'never touch secrets',
        argsSummary: '{"path":"secrets/key.pem"}',
      },
      { sessionId: 'sess-1', cwd: '/tmp/proj' },
    );
    // A subscription returns NOTHING — there is no verdict channel at all.
    expect(result).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe('PermissionRequest');
    expect(received[0]?.body).toMatchObject({
      event: 'PermissionRequest',
      sessionId: 'sess-1',
      cwd: '/tmp/proj',
      permission: {
        tool: 'write_file',
        categories: ['write'],
        effect: 'deny',
        matchedRuleId: 'no-secrets',
        source: 'project',
        reason: 'never touch secrets',
        argsSummary: '{"path":"secrets/key.pem"}',
      },
    });
  });

  it('PermissionRequest is TOOL-SCOPED: a hook for another tool never fires', async () => {
    const logs: string[] = [];
    const runner = new LifecycleHookRunner({ logger: (m) => logs.push(m) });
    runner.addHook({
      name: 'bash-only',
      match: { tools: ['bash'], events: ['PermissionRequest'] },
      url,
    });
    await runner.runPermissionRequest({ tool: 'write_file', categories: ['write'], effect: 'ask' });
    expect(received).toHaveLength(0);

    await runner.runPermissionRequest({ tool: 'Bash', categories: ['execute'], effect: 'ask' });
    expect(received).toHaveLength(1);
    expect(received[0]?.body.permission?.tool).toBe('Bash');
  });

  it('SubagentStart / SubagentEnd carry the tentacle identity + WS3 isolation flag', async () => {
    const { runner } = observerRunner(['SubagentStart', 'SubagentEnd']);
    await runner.runSubagentStart({
      agent: 'general',
      description: 'fix the parser',
      thoroughness: 'normal',
      worktree: true,
      worktreeMode: 'on',
      worktreePath: '/tmp/wt-1',
      nodeId: 'n1',
      graphId: 'g1',
      cwd: '/tmp/wt-1',
    });
    await runner.runSubagentEnd({
      agent: 'general',
      description: 'fix the parser',
      worktree: false,
      worktreeMode: 'auto',
      ok: false,
      durationMs: 1234,
      error: 'verify failed',
    });

    expect(received.map((r) => r.event)).toEqual(['SubagentStart', 'SubagentEnd']);
    expect(received[0]?.body.subagent).toMatchObject({
      agent: 'general',
      description: 'fix the parser',
      thoroughness: 'normal',
      worktree: true,
      worktreeMode: 'on',
      worktreePath: '/tmp/wt-1',
      nodeId: 'n1',
      graphId: 'g1',
      cwd: '/tmp/wt-1',
    });
    // An absent `ok` is never a success claim; here it is explicitly false.
    expect(received[1]?.body.subagent).toMatchObject({
      agent: 'general',
      worktree: false,
      worktreeMode: 'auto',
      ok: false,
      durationMs: 1234,
      error: 'verify failed',
    });
    expect(received[1]?.body.subagent && 'worktreePath' in received[1].body.subagent).toBe(false);
  });

  it('SubagentStart honors match.agents as an optional kind filter', async () => {
    const { runner } = observerRunner(['SubagentStart'], {
      match: { tools: ['*'], events: ['SubagentStart'], agents: ['explore'] },
    });
    await runner.runSubagentStart({ agent: 'general', description: 'w', worktree: false });
    expect(received).toHaveLength(0);
    await runner.runSubagentStart({ agent: 'Explore', description: 'r', worktree: false });
    expect(received).toHaveLength(1);
  });

  it('Notification carries the WS2 inbox source vocabulary', async () => {
    const { runner } = observerRunner(['Notification']);
    await runner.runNotification({
      source: 'needs-input',
      kind: 'permission.denied',
      summary: 'tool "write_file" was denied by no-secrets',
      tool: 'write_file',
      seq: 12,
    });
    expect(received[0]?.event).toBe('Notification');
    expect(received[0]?.body).toMatchObject({
      event: 'Notification',
      notification: {
        source: 'needs-input',
        kind: 'permission.denied',
        summary: 'tool "write_file" was denied by no-secrets',
        tool: 'write_file',
        seq: 12,
      },
    });
  });
});

describe('an observer NEVER blocks or corrupts the spine (acceptance 2)', () => {
  it('a hook that never answers does not stall the caller beyond its timeout', async () => {
    behavior = 'hang';
    const { runner, logs } = observerRunner(['Notification']);
    const started = Date.now();
    await runner.runNotification({ source: 'question', summary: 'a question' });
    const elapsed = Date.now() - started;
    // Bounded by the hook's own timeoutMs (300), not by the server's 5s.
    expect(elapsed).toBeLessThan(1500);
    // And the unreliable outcome is LOGGED, never silent: HTTP hooks abort
    // (command hooks report "timed out after Nms" instead).
    expect(logs.some((l) => l.includes('observer') && l.includes('fail-open'))).toBe(true);
  });

  it('a non-2xx HTTP response is logged and swallowed', async () => {
    behavior = 'http500';
    const { runner, logs } = observerRunner(['PermissionRequest']);
    await expect(
      runner.runPermissionRequest({ tool: 'bash', categories: ['execute'], effect: 'ask' }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('HTTP 500'))).toBe(true);
  });

  it('a `deny` decision from an observer is DISCARDED (subscriptions cannot gate)', async () => {
    behavior = 'deny';
    const { runner } = observerRunner(['SubagentStart']);
    const res = await runner.runSubagentStart({ agent: 'general', description: 'x', worktree: false });
    expect(res).toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it('fail-closed mode changes NOTHING for observers: unreliable ⇒ logged, never a verdict', async () => {
    behavior = 'http500';
    const logs: string[] = [];
    const runner = new LifecycleHookRunner({
      failureMode: 'fail-closed',
      logger: (m) => logs.push(m),
    });
    runner.addHook({
      name: 'observer',
      match: { tools: ['*'], events: ['Notification'] },
      url,
      timeoutMs: 300,
    });
    expect(runner.failureMode).toBe('fail-closed');
    await expect(runner.runNotification({ source: 'question', summary: 'q' })).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('fail-closed'))).toBe(true);
  });

  it('an unreliable GATE hook still follows the failure mode (fail-open unchanged)', async () => {
    behavior = 'http500';
    const { runner } = observerRunner(['PreToolUse']);
    const pre = await runner.runPreToolUse('bash', { command: 'ls' }, { cwd: '/tmp' });
    expect(pre).toEqual({ ok: true });

    const closed = new LifecycleHookRunner({ failureMode: 'fail-closed', logger: () => undefined });
    closed.addHook({ name: 'gate', match: { tools: ['bash'], events: ['PreToolUse'] }, url, timeoutMs: 300 });
    expect(await closed.runPreToolUse('bash', { command: 'ls' }, { cwd: '/tmp' })).toMatchObject({
      ok: false,
      reason: 'hook-failed',
    });
  });
});

describe('observer matching + payload helpers', () => {
  it('exposes the four observer event names', () => {
    expect(OBSERVER_HOOK_EVENTS).toEqual([
      'PermissionRequest',
      'SubagentStart',
      'SubagentEnd',
      'Notification',
    ]);
    expect(isObserverEvent('Notification')).toBe(true);
    expect(isObserverEvent('PreToolUse')).toBe(false);
  });

  it('hookMatches: tool-scoped vs agent-scoped vs subject-less', () => {
    const hook: HookDefinition = {
      name: 'h',
      match: { tools: ['bash'], events: ['PermissionRequest', 'Notification', 'SubagentStart'], agents: ['general'] },
      command: 'node x.mjs',
    };
    expect(hookMatches(hook, 'PermissionRequest', 'bash')).toBe(true);
    expect(hookMatches(hook, 'PermissionRequest', 'write_file')).toBe(false);
    expect(hookMatches(hook, 'PermissionRequest', undefined)).toBe(false);
    // `tools` is NOT consulted for subagent events — `agents` is.
    expect(hookMatches(hook, 'SubagentStart', undefined, 'general')).toBe(true);
    expect(hookMatches(hook, 'SubagentStart', undefined, 'verify')).toBe(false);
    // Notification carries no subject: the event decides.
    expect(hookMatches(hook, 'Notification', undefined)).toBe(true);
  });

  it('summarizeHookArgs is bounded and never throws', () => {
    expect(summarizeHookArgs({ a: 1 })).toBe('{"a":1}');
    expect(summarizeHookArgs(undefined)).toBe('');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeHookArgs(circular)).toBe('[unserializable]');
    expect(summarizeHookArgs('x'.repeat(500), 20)).toHaveLength(20);
    expect(summarizeHookArgs('a\n  b')).toBe('a b');
  });
});
