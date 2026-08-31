import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import {
  defaultPermissionPolicy,
  clearSessionPermissionGrants,
} from '../../src/cli/safety/toolPermissions.js';
import { createPermissionAskHandler } from '../../src/cli/hooks/permissionPicker.js';
import type { PickerRequest } from '../../src/cli/slashHandlers/provider.js';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const REAL = { ...process.env };

beforeEach(() => {
  process.env = { ...REAL };
  delete process.env.ZELARI_AUTO;
  delete process.env.ZELARI_PERMISSION_EXECUTE;
  delete process.env.ZELARI_PERMISSION_NETWORK;
  clearSessionPermissionGrants();
});

afterEach(() => {
  process.env = { ...REAL };
  clearSessionPermissionGrants();
});

function makeCtx(root: string): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    audit: () => {},
    sessionId: 'claims-t',
  };
}

describe('permission ask carries policy-engine claims (v2.20)', () => {
  it('picker handler renders claims + policy note in the transcript', async () => {
    const sys: string[] = [];
    let req: PickerRequest | null = null;
    const handler = createPermissionAskHandler({
      setPicker: (r) => { req = r; },
      appendSystem: (m) => { sys.push(m); },
    });
    const p = handler({
      toolName: 'bash',
      reason: 'Tool "bash" requires approval (execute).',
      categories: ['execute'],
      args: { command: 'git push origin main' },
      policyNote: "[policy] claim 'git push*' — protect main",
      claims: [{ kind: 'process', summary: 'process: git push origin main' }],
    });
    expect(req).not.toBeNull();
    const joined = sys.join('\n');
    expect(joined).toContain('process: git push origin main');
    expect(joined).toContain('protect main');
    (req as PickerRequest).onAnswer('allow');
    await expect(p).resolves.toBe(true);
  });

  it('registry: default ask on execute forwards the claim expansion to onPermissionAsk', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perm-claims-'));
    const asks: Array<{ toolName: string; claims?: readonly { kind: string; summary: string }[]; policyNote?: string }> = [];
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        enableTask: false,
        lspProvider: null,
        permissionPolicy: defaultPermissionPolicy(),
        onPermissionAsk: async (r) => {
          asks.push({ toolName: r.toolName, claims: r.claims, policyNote: r.policyNote });
          return true;
        },
      });
      const bash = registry.get('bash');
      if (!bash) throw new Error('bash not registered');
      const res = (await bash.execute({ command: 'echo claim-probe' } as never, makeCtx(root))) as {
        ok: boolean;
        error?: string;
      };
      expect(asks).toHaveLength(1);
      expect(asks[0].toolName).toBe('bash');
      expect(asks[0].claims?.some((c) => c.summary.includes('echo claim-probe'))).toBe(true);
      expect(asks[0].policyNote).toBeUndefined();
      // Spawn success is environment-dependent (Windows vitest) — the CONTRACT
      // is that approval passed: never a permission denial.
      const passedApproval = res.ok === true || !String(res.error ?? '').includes('[permission]');
      expect(passedApproval).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('policy-engine ask rule surfaces its reason via policyNote (claim from policy.json)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perm-claims-rule-'));
    mkdirSync(path.join(root, '.zelari'), { recursive: true });
    writeFileSync(
      path.join(root, '.zelari', 'policy.json'),
      JSON.stringify({
        version: 2,
        agents: {
          lead: { claims: [{ kind: 'process', pattern: 'git push*', effect: 'ask', reason: 'protect main' }] },
        },
      }),
    );
    const asks: Array<{ claims?: readonly { kind: string; summary: string }[]; policyNote?: string }> = [];
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        enableTask: false,
        lspProvider: null,
        permissionPolicy: {
          read: 'allow', write: 'allow', execute: 'allow', network: 'allow', ui: 'allow', auto: false,
        },
        onPermissionAsk: async (r) => {
          asks.push({ claims: r.claims, policyNote: r.policyNote });
          return false;
        },
      });
      const bash = registry.get('bash');
      if (!bash) throw new Error('bash not registered');
      const res = (await bash.execute({ command: 'git push origin main' } as never, makeCtx(root))) as {
        ok: boolean;
        error?: string;
      };
      expect(asks).toHaveLength(1);
      expect(asks[0].policyNote).toContain('protect main');
      expect(asks[0].claims?.some((c) => c.summary.startsWith('process: git push'))).toBe(true);
      expect(res.ok).toBe(false);
      expect(String(res.error ?? '')).toContain('denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
