/**
 * verificationFailedHook.test.ts — K5.3 / F32: the `VerificationFailed`
 * lifecycle hook, fired when the strict-done gate BLOCKS a turn.
 *
 * Acceptance pinned here (same observer contract as WS5):
 *  1. a registered hook receives the STRUCTURED payload
 *     ({ event, verification: { criteria, reason } });
 *  2. the hook is a SUBSCRIPTION: crash / timeout / non-2xx never blocks the
 *     caller and the decision it replies with is DISCARDED — this event
 *     reports a final verdict, it never changes one;
 *  3. matching: `VerificationFailed` carries no subject (the event decides).
 *
 * HTTP hooks are used instead of spawned processes: the file stays hermetic,
 * cross-platform and fast, and the request BODY is the payload under test.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LifecycleHookRunner } from './lifecycleHookRunner.js';
import {
  hookMatches,
  type AnyHookPayload,
  type HookDefinition,
  type VerificationFailedPayload,
} from './types.js';

/** What the fake endpoint does when a hook fires. */
type Behavior = 'allow' | 'deny' | 'http500' | 'hang';

let server: Server;
let url: string;
const received: AnyHookPayload[] = [];
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
        received.push(JSON.parse(raw) as AnyHookPayload);
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
            ? JSON.stringify({ decision: 'deny', reason: 'an observer cannot gate' })
            : JSON.stringify({ decision: 'allow' }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
    });
  });
}

function failedRunner(events: HookDefinition['match']['events'], extra: Partial<HookDefinition> = {}) {
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

const FAILURE: VerificationFailedPayload = {
  criteria: ['correctness.error-signals', 'check-1-session-survives-concurrent-refresh'],
  reason: 'strict REPAIR_REQUIRED: evidence incomplete',
};

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

describe('runVerificationFailed (K5.3 / F32)', () => {
  it('delivers the structured { criteria, reason } payload and resolves void', async () => {
    const { runner } = failedRunner(['VerificationFailed']);
    await expect(runner.runVerificationFailed(FAILURE)).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: 'VerificationFailed',
      verification: FAILURE,
    });
  });

  it('only hooks registered for the event fire', async () => {
    const { runner } = failedRunner(['PreToolUse']);
    await runner.runVerificationFailed(FAILURE);
    expect(received).toHaveLength(0);
  });

  it('a deny decision is DISCARDED (this event reports a final verdict)', async () => {
    behavior = 'deny';
    const { runner } = failedRunner(['VerificationFailed']);
    await expect(runner.runVerificationFailed(FAILURE)).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it('a crashing hook is logged and swallowed (observer never propagates)', async () => {
    behavior = 'http500';
    const { runner, logs } = failedRunner(['VerificationFailed']);
    await expect(runner.runVerificationFailed(FAILURE)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('observer'))).toBe(true);
  });

  it('a hanging hook is bounded by its own timeout and never blocks', async () => {
    behavior = 'hang';
    const { runner } = failedRunner(['VerificationFailed']);
    const started = Date.now();
    await runner.runVerificationFailed(FAILURE);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('fail-closed mode changes NOTHING: this hook can never produce a verdict', async () => {
    behavior = 'http500';
    const logs: string[] = [];
    const runner = new LifecycleHookRunner({
      failureMode: 'fail-closed',
      logger: (m) => logs.push(m),
    });
    runner.addHook({
      name: 'observer',
      match: { tools: ['*'], events: ['VerificationFailed'] },
      url,
      timeoutMs: 300,
    });
    await expect(runner.runVerificationFailed(FAILURE)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('fail-closed'))).toBe(true);
  });

  it('matching: the event carries no subject — tools are not consulted', () => {
    const hook: HookDefinition = {
      name: 'h',
      match: { tools: ['bash'], events: ['VerificationFailed'] },
      command: 'node x.mjs',
    };
    expect(hookMatches(hook, 'VerificationFailed', undefined)).toBe(true);
    expect(hookMatches(hook, 'PreToolUse', 'bash')).toBe(false);
  });
});
