/**
 * WS5 (t137) — the PermissionRequest / Notification observer hooks at the REAL
 * registry seam.
 *
 * Pins:
 *   - the gate's resolution to `ask` / `deny` fires `PermissionRequest` with
 *     the structured payload (tool, categories, effect, matched WS1 rule with
 *     source+reason, bounded argsSummary), and a denial ALSO fires the WS2
 *     `Notification` (the inbox gained a `needs-input` item);
 *   - a THROWING or HANGING subscriber changes NOTHING: the verdict is
 *     byte-identical and the dispatch is not delayed — hooks are subscribers,
 *     never a second gate (WS1 fail-open/fail-closed untouched);
 *   - zero rules configured ⇒ zero observer calls (no behavior change).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LifecycleHookRunner } from '@zelari/core/harness';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import { createBuiltinToolRegistry } from '../toolRegistry.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './toolPermissions.js';
import { clearSessionPermissionRules, resetProjectPermissionRuleCache } from './permissionRules.js';
import { clearPermissionDenials, buildPermissionRequestHookPayload } from './permissionGate.js';

let root: string;

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function writePermissionsFile(content: unknown | string): void {
  const dir = path.join(root, '.zelari');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'permissions.json'),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

function makeCtx(): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    audit: () => undefined,
    sessionId: 'ws5-hooks',
  };
}

interface ObserverCall {
  event: string;
  payload: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

/**
 * A recording stand-in for LifecycleHookRunner. `mode` reproduces the three
 * ways a subscriber misbehaves: it answers, it throws, it never answers.
 */
function fakeRunner(mode: 'ok' | 'throw' | 'hang' = 'ok'): {
  calls: ObserverCall[];
  runner: LifecycleHookRunner;
} {
  const calls: ObserverCall[] = [];
  const record = (event: string) => async (payload: unknown, ctx: unknown) => {
    calls.push({
      event,
      payload: (payload ?? {}) as Record<string, unknown>,
      ctx: (ctx ?? {}) as Record<string, unknown>,
    });
    if (mode === 'throw') throw new Error(`observer ${event} exploded`);
    if (mode === 'hang') await new Promise<void>(() => undefined);
  };
  const runner = {
    failureMode: 'fail-open',
    listHooks: () => [],
    runPermissionRequest: record('PermissionRequest'),
    runSubagentStart: record('SubagentStart'),
    runSubagentEnd: record('SubagentEnd'),
    runNotification: record('Notification'),
    runPreToolUse: async () => ({ ok: true }),
    runPostToolUse: async () => undefined,
    runSessionStart: async () => ({ ok: true }),
    runSessionEnd: async () => ({ ok: true }),
  } as unknown as LifecycleHookRunner;
  return { calls, runner };
}

function registryWith(runner: LifecycleHookRunner | null, policy: PermissionPolicy = allowAll()) {
  const { registry } = createBuiltinToolRegistry({
    root,
    audit: new AuditLogger(path.join(os.tmpdir(), `zelari-ws5-${Date.now()}-${Math.random()}.log`)),
    sessionId: 'ws5-hooks',
    enableTask: false,
    enableSkill: false,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: policy,
    lifecycleHooks: runner,
  });
  return registry;
}

async function writeFileWith(
  runner: LifecycleHookRunner | null,
  pathArg: string,
  policy: PermissionPolicy = allowAll(),
): Promise<{ ok: boolean; error?: string }> {
  const tool = registryWith(runner, policy).get('write_file');
  if (!tool) throw new Error('write_file not registered');
  return (await tool.execute({ path: pathArg, content: 'x' } as never, makeCtx())) as {
    ok: boolean;
    error?: string;
  };
}

const denySecrets = {
  version: 1,
  rules: [{ id: 'no-secrets', effect: 'deny', tool: 'write_file', pathPrefix: 'secrets', note: 'never touch secrets' }],
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zelari-ws5-hooks-'));
  await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'secrets', 'key.pem'), 'old', 'utf-8');
  resetProjectPermissionRuleCache();
  clearSessionPermissionRules();
  clearSessionPermissionGrants();
  clearPermissionDenials();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('WS5 PermissionRequest hook (registry integration)', () => {
  it('a rule deny fires PermissionRequest{effect:deny,+rule} and the inbox Notification', async () => {
    writePermissionsFile(denySecrets);
    const { calls, runner } = fakeRunner();
    const res = await writeFileWith(runner, 'secrets/key.pem');

    // The WS1 verdict is untouched: same deny, same named rule.
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-secrets'");
    expect(await fs.readFile(path.join(root, 'secrets', 'key.pem'), 'utf-8')).toBe('old');

    const request = calls.find((c) => c.event === 'PermissionRequest');
    expect(request).toBeDefined();
    expect(request?.payload).toMatchObject({
      tool: 'write_file',
      categories: ['write'],
      effect: 'deny',
      matchedRuleId: 'no-secrets',
      source: 'project',
    });
    expect(String(request?.payload.reason)).toContain('never touch secrets');
    expect(String(request?.payload.argsSummary)).toContain('secrets/key.pem');
    expect(request?.ctx).toMatchObject({ sessionId: 'ws5-hooks', cwd: root });

    // A denial is exactly when the WS2 inbox gains a `needs-input` item.
    const notification = calls.find((c) => c.event === 'Notification');
    expect(notification?.payload).toMatchObject({
      source: 'needs-input',
      kind: 'permission.denied',
      tool: 'write_file',
    });
  });

  it('a category ASK fires PermissionRequest with no rule attached', async () => {
    const { calls, runner } = fakeRunner();
    const res = await writeFileWith(runner, 'docs/b.md', { ...allowAll(), write: 'ask', auto: false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No interactive approval available');

    const request = calls.find((c) => c.event === 'PermissionRequest');
    expect(request?.payload).toMatchObject({ tool: 'write_file', effect: 'ask' });
    expect(request?.payload.matchedRuleId).toBeUndefined();
    // An ask is not an inbox item.
    expect(calls.some((c) => c.event === 'Notification')).toBe(false);
  });

  it('a THROWING subscriber cannot change the verdict nor fail the dispatch', async () => {
    writePermissionsFile(denySecrets);
    const { runner } = fakeRunner('throw');
    const res = await writeFileWith(runner, 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-secrets'");
  });

  it('a HANGING subscriber cannot stall the dispatch', async () => {
    writePermissionsFile(denySecrets);
    const { calls, runner } = fakeRunner('hang');
    const started = Date.now();
    const res = await writeFileWith(runner, 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('zero rules ⇒ zero observer calls, today’s behavior', async () => {
    const { calls, runner } = fakeRunner();
    const res = await writeFileWith(runner, 'docs/b.md');
    expect(res.ok, res.error).toBe(true);
    expect(calls).toEqual([]);
  });

  it('no runner configured is a silent no-op (hook surface is opt-in)', async () => {
    writePermissionsFile(denySecrets);
    const res = await writeFileWith(null, 'secrets/key.pem');
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rule 'no-secrets'");
  });
});

describe('buildPermissionRequestHookPayload (pure)', () => {
  it('omits everything a decision did not carry', () => {
    expect(buildPermissionRequestHookPayload({ tool: 'bash', categories: ['execute'], effect: 'ask' })).toEqual({
      tool: 'bash',
      categories: ['execute'],
      effect: 'ask',
    });
  });

  it('copies the categories and bounds the args summary', () => {
    const categories = ['write'];
    const payload = buildPermissionRequestHookPayload({
      tool: 'write_file',
      categories,
      effect: 'deny',
      verdict: {
        decision: 'deny',
        source: 'project',
        reason: 'no',
        matchedRuleId: 'r1',
      },
      args: { path: 'a'.repeat(1000) },
    });
    expect(payload.categories).toEqual(['write']);
    expect(payload.categories).not.toBe(categories);
    expect((payload.argsSummary ?? '').length).toBeLessThanOrEqual(300);
    expect(payload).toMatchObject({ matchedRuleId: 'r1', source: 'project', reason: 'no' });
  });
});
