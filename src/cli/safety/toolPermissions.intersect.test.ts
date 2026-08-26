/**
 * intersectPermissionPolicy — P0.4 capability inheritance.
 *
 * A Kraken tentacle (sub-agent spawned via the `task` tool) must NEVER hold
 * more permission than its parent: the sub-agent's effective policy is
 * intersectPermissionPolicy(parentPolicy, subProfilePolicy) under the lattice
 * deny > ask > allow (most restrictive wins), and `auto` intersects as AND.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';
import { AuditLogger } from './auditLogger.js';
import {
  clearSessionPermissionGrants,
  defaultPermissionPolicy,
  intersectPermissionPolicy,
  type PermissionAction,
  type PermissionPolicy,
} from './toolPermissions.js';
// createBuiltinToolRegistry is the exact builder that
// createKrakenSubAgentContextFactory delegates to (same options shape), used
// below for the enforcement-level regression — same import style as
// taskTool.planSafety.test.ts.
import { createBuiltinToolRegistry } from '../toolRegistry.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'zelari-intersect-'));
}

/** All-allow policy (headless / sub-agent style). */
function allowAll(auto = true): PermissionPolicy {
  return {
    read: 'allow',
    write: 'allow',
    execute: 'allow',
    network: 'allow',
    ui: 'allow',
    auto,
  };
}

/** All-allow base with per-category overrides (auto off by default). */
function policy(overrides: Partial<PermissionPolicy>): PermissionPolicy {
  return { ...allowAll(false), ...overrides };
}

function makeAudit(): AuditLogger {
  return new AuditLogger(
    path.join(
      tmpdir(),
      `zelari-intersect-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ),
  );
}

function makeCtx(cwd: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    audit: () => undefined,
    sessionId: 'intersect-permission-test',
  };
}

/** Sub-agent-shaped registry: the options createKrakenSubAgentContextFactory
 * passes for a `general` tentacle, with the effective policy supplied. */
function makeSubRegistry(effective: PermissionPolicy) {
  return createBuiltinToolRegistry({
    root: repoRoot,
    audit: makeAudit(),
    sessionId: 'intersect-test',
    profile: 'general',
    enableTask: false,
    enableSkill: true,
    diagnostics: false,
    lspProvider: null,
    permissionPolicy: effective,
  });
}

describe('intersectPermissionPolicy (P0.4 capability inheritance)', () => {
  beforeEach(() => {
    clearSessionPermissionGrants();
  });

  it('lattice: deny beats ask beats allow, per category', () => {
    const cases: Array<[PermissionAction, PermissionAction, PermissionAction]> = [
      ['allow', 'allow', 'allow'],
      ['allow', 'ask', 'ask'],
      ['ask', 'allow', 'ask'],
      ['allow', 'deny', 'deny'],
      ['deny', 'allow', 'deny'],
      ['ask', 'deny', 'deny'],
      ['deny', 'ask', 'deny'],
      ['ask', 'ask', 'ask'],
      ['deny', 'deny', 'deny'],
    ];
    for (const [parentAction, childAction, expected] of cases) {
      const merged = intersectPermissionPolicy(
        policy({ write: parentAction }),
        policy({ write: childAction }),
      );
      expect(merged.write).toBe(expected);
    }
  });

  it('child allow + parent deny -> deny (child cannot exceed parent)', () => {
    for (const cat of ['read', 'write', 'execute', 'network', 'ui'] as const) {
      const merged = intersectPermissionPolicy(policy({ [cat]: 'deny' }), allowAll());
      expect(merged[cat]).toBe('deny');
    }
  });

  it('child deny + parent allow -> deny (most restrictive wins both ways)', () => {
    for (const cat of ['read', 'write', 'execute', 'network', 'ui'] as const) {
      const merged = intersectPermissionPolicy(allowAll(), policy({ [cat]: 'deny' }));
      expect(merged[cat]).toBe('deny');
    }
  });

  it('both allow -> allow (no accidental tightening)', () => {
    expect(intersectPermissionPolicy(allowAll(), allowAll())).toEqual(allowAll());
  });

  it('auto intersects as AND: a prompt-mode parent disables child auto-allow', () => {
    expect(intersectPermissionPolicy(allowAll(false), allowAll(true)).auto).toBe(false);
    expect(intersectPermissionPolicy(allowAll(true), allowAll(true)).auto).toBe(true);
    expect(intersectPermissionPolicy(allowAll(false), allowAll(false)).auto).toBe(false);
  });

  it('missing parent input -> default fallback is a no-op intersection', () => {
    // The factory's fallback path (parentPolicy omitted) intersects the
    // default policy with itself: identity, so behavior without a parent
    // policy in scope is unchanged and the only escalation fix is the
    // intersection itself.
    const fallback = defaultPermissionPolicy({ auto: true });
    expect(intersectPermissionPolicy(fallback, fallback)).toEqual(fallback);
  });
});

describe('enforcement through a sub-agent-shaped registry', () => {
  // NOTE (P0.4 contract): asserting this at the createKrakenSubAgentContextFactory
  // level directly would require a provider config (providerFromEnv) to pass
  // the null-provider gate, i.e. provider mocks — excluded by the contract.
  // The factory feeds createBuiltinToolRegistry exactly the expression below
  // (intersectPermissionPolicy(parentPolicy ?? default, default), see
  // `effectiveSubPolicy` in toolRegistry.ts), so enforcing the intersection
  // at the registry level proves what the tentacle would actually execute.

  beforeEach(() => {
    clearSessionPermissionGrants();
  });

  it('a parent-deny on execute keeps bash denied in the sub-registry', async () => {
    const effective = intersectPermissionPolicy(
      policy({ execute: 'deny' }),
      defaultPermissionPolicy({ auto: true }),
    );
    expect(effective.execute).toBe('deny');

    const { registry } = makeSubRegistry(effective);
    const bash = registry.get('bash');
    if (!bash) throw new Error('bash not registered for profile=general');
    const res = (await bash.execute(
      { command: 'echo escalated' } as never,
      makeCtx(tmpRoot()),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('[permission]');
  });

  it('ask without an interactive handler fails CLOSED (deny), not open', async () => {
    // Parent is prompt-mode (write: ask, auto off); the sub-agent context
    // has no onPermissionAsk, so the intersection's `ask` must NOT execute.
    const effective = intersectPermissionPolicy(
      policy({ write: 'ask', auto: false }),
      defaultPermissionPolicy({ auto: true }),
    );
    expect(effective.write).toBe('ask');
    expect(effective.auto).toBe(false);

    const { registry } = makeSubRegistry(effective);
    const writeFile = registry.get('write_file');
    if (!writeFile) throw new Error('write_file not registered for profile=general');
    const dir = tmpRoot();
    const res = (await writeFile.execute(
      { path: path.join(dir, 'escalation.txt'), content: 'x' } as never,
      makeCtx(dir),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No interactive approval available');
    expect(fs.existsSync(path.join(dir, 'escalation.txt'))).toBe(false);
  });
});
