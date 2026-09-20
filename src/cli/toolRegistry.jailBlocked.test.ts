/**
 * toolRegistry.jailBlocked.test.ts — WS7 slice 4 (t139).
 *
 * The `bash` surface denies a spawn at its OWN preflight (v2.17 t28: required +
 * no honest backend ⇒ typed `[jail]` deny BEFORE the builtin runs) — that is a
 * DECISION on the harness side, so it must reach the session spine as
 * `jail.blocked`, exactly like the exec_process deny does at the spawn itself.
 *
 * Red-if-reopens: without the emission the registry integration reports zero
 * `jail.blocked` events even though the deny fired.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  SESSION_SCHEMA_VERSION,
  buildProjection,
  decisionPayloadError,
  type SessionEventEnvelope,
  type SessionEventInput,
} from '@zelari/core/session';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './safety/auditLogger.js';
import { setJailBackendForTests } from './safety/osJail.js';
import { clearSessionPermissionGrants, type PermissionPolicy } from './safety/toolPermissions.js';
import { createBuiltinToolRegistry } from './toolRegistry.js';

const unavailable = {
  id: 'stub-jail',
  probe: () => ({ backend: 'stub-jail', available: false, reason: 'no backend in this test' }),
  wrap: () => {
    throw new Error('an unavailable backend must never wrap');
  },
};

function allowAll(): PermissionPolicy {
  return { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: true };
}

function envelopes(inputs: readonly SessionEventInput[]): SessionEventEnvelope[] {
  return inputs.map((input, i) => ({
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: 'ws7-jail',
    seq: i + 1,
    ts: 1_700_000_000_000 + i,
    kind: input.kind,
    actor: input.actor,
    data: input.data ?? {},
  }));
}

describe('WS7 slice 4 — jail.blocked at the bash preflight deny', () => {
  let root: string;
  const savedMode = process.env.ZELARI_OS_JAIL;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'zelari-ws7-jail-'));
    clearSessionPermissionGrants();
  });

  afterEach(() => {
    setJailBackendForTests(null);
    if (savedMode === undefined) delete process.env.ZELARI_OS_JAIL;
    else process.env.ZELARI_OS_JAIL = savedMode;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('required + no backend ⇒ typed [jail] deny and one jail.blocked event (tool: bash)', async () => {
    process.env.ZELARI_OS_JAIL = 'required';
    setJailBackendForTests(unavailable);
    const events: SessionEventInput[] = [];
    const { registry } = createBuiltinToolRegistry({
      root,
      audit: new AuditLogger(
        path.join(tmpdir(), `zelari-ws7-jail-${Date.now()}-${Math.random().toString(36).slice(2)}.log`),
      ),
      sessionId: 'ws7-jail',
      profile: 'general',
      enableTask: false,
      enableSkill: false,
      diagnostics: false,
      lspProvider: null,
      permissionPolicy: allowAll(),
    });
    const bash = registry.get('bash');
    if (!bash) throw new Error('bash not registered');
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      cwd: root,
      audit: () => undefined,
      sessionId: 'ws7-jail',
      emitSessionEvent: async (input) => {
        events.push(input);
        return { seq: events.length };
      },
    };

    const res = await bash.execute({ command: 'echo never-runs' } as never, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');
    // One decision per seam: the permission wrapper ALSO records its allow
    // (execute category default ⇒ auto_approve.granted), so filter the kind.
    const blocked = events.filter((e) => e.kind === 'jail.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.data).toMatchObject({ tool: 'bash', backend: 'stub-jail', mode: 'required' });
    expect(decisionPayloadError('jail.blocked', blocked[0]!.data)).toBeNull();

    const projection = buildProjection(envelopes(events));
    const kinds = projection.decisionEvents.map((d) => d.kind);
    expect(kinds).toContain('jail.blocked');
    const jailSummary = projection.decisionEvents.find((d) => d.kind === 'jail.blocked');
    expect(jailSummary!.reason).toContain('[jail]');
    expect(jailSummary!.detail).toContain('stub-jail required');
  });

  it('BEST-EFFORT: a THROWING sink cannot soften the bash deny', async () => {
    process.env.ZELARI_OS_JAIL = 'required';
    setJailBackendForTests(unavailable);
    const { registry } = createBuiltinToolRegistry({
      root,
      audit: new AuditLogger(path.join(tmpdir(), `zelari-ws7-jail-locked-${Date.now()}.log`)),
      sessionId: 'ws7-jail',
      profile: 'general',
      enableTask: false,
      enableSkill: false,
      diagnostics: false,
      lspProvider: null,
      permissionPolicy: allowAll(),
    });
    const bash = registry.get('bash');
    if (!bash) throw new Error('bash not registered');
    const res = await bash.execute({ command: 'echo never-runs' } as never, {
      signal: new AbortController().signal,
      cwd: root,
      audit: () => undefined,
      sessionId: 'ws7-jail',
      emitSessionEvent: () => Promise.reject(new Error('SESSION_LOG_LOCKED')),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('[jail]');
  });
});
