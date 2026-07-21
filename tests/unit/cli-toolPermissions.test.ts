import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  defaultPermissionPolicy,
  resolveToolPermission,
  isAutoPermissions,
  grantSessionTool,
  grantSessionCategory,
  clearSessionPermissionGrants,
  isSessionGranted,
} from '../../src/cli/safety/toolPermissions.js';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from '@zelari/core/harness/tools/toolTypes';

const REAL = { ...process.env };

beforeEach(() => {
  process.env = { ...REAL };
  delete process.env.ZELARI_AUTO;
  delete process.env.ZELARI_PERMISSION_WRITE;
  delete process.env.ZELARI_PERMISSION_EXECUTE;
  clearSessionPermissionGrants();
});

afterEach(() => {
  process.env = { ...REAL };
  clearSessionPermissionGrants();
});

describe('toolPermissions', () => {
  it('defaults to allow for all categories', () => {
    const p = defaultPermissionPolicy();
    expect(p.write).toBe('allow');
    expect(p.execute).toBe('allow');
    expect(p.auto).toBe(false);
  });

  it('honors env overrides and ZELARI_AUTO', () => {
    process.env.ZELARI_PERMISSION_EXECUTE = 'ask';
    process.env.ZELARI_AUTO = '1';
    const p = defaultPermissionPolicy();
    expect(p.execute).toBe('ask');
    expect(p.auto).toBe(true);
    expect(isAutoPermissions()).toBe(true);
  });

  it('deny wins over ask', () => {
    const d = resolveToolPermission(
      'bash',
      ['execute', 'read'],
      defaultPermissionPolicy({ execute: 'deny', read: 'ask' }),
    );
    expect(d.action).toBe('deny');
  });

  it('auto promotes ask to allow', () => {
    const d = resolveToolPermission(
      'bash',
      ['execute'],
      defaultPermissionPolicy({ execute: 'ask', auto: true }),
    );
    expect(d.action).toBe('allow');
  });

  it('registry denies execute tools when policy is deny', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perm-'));
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        permissionPolicy: defaultPermissionPolicy({ execute: 'deny' }),
        enableTask: false,
        lspProvider: null,
      });
      const bash = registry.get('bash');
      expect(bash).toBeDefined();
      const ctx: ToolContext = {
        signal: new AbortController().signal,
        cwd: root,
        audit: () => {},
        sessionId: 't',
      };
      const res = await bash!.execute({ command: 'echo hi' }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/permission|denied/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('session tool grant promotes ask to allow', () => {
    grantSessionTool('bash');
    expect(isSessionGranted('bash', ['execute'])).toBe(true);
    const d = resolveToolPermission(
      'bash',
      ['execute'],
      defaultPermissionPolicy({ execute: 'ask', auto: false }),
    );
    expect(d.action).toBe('allow');
  });

  it('session category grant covers tools needing that category', () => {
    grantSessionCategory('execute');
    const d = resolveToolPermission(
      'bash',
      ['execute'],
      defaultPermissionPolicy({ execute: 'ask', auto: false }),
    );
    expect(d.action).toBe('allow');
  });

  it('explicit deny still wins over session grant', () => {
    grantSessionTool('bash');
    const d = resolveToolPermission(
      'bash',
      ['execute'],
      defaultPermissionPolicy({ execute: 'deny', auto: false }),
    );
    expect(d.action).toBe('deny');
  });

  it('ask without handler denies with clear message', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perm-ask-'));
    try {
      const { registry } = createBuiltinToolRegistry({
        root,
        permissionPolicy: defaultPermissionPolicy({ write: 'ask', auto: false }),
        enableTask: false,
        lspProvider: null,
      });
      const write = registry.get('write_file');
      expect(write).toBeDefined();
      const ctx: ToolContext = {
        signal: new AbortController().signal,
        cwd: root,
        audit: () => {},
        sessionId: 't',
      };
      const res = await write!.execute(
        { path: 'x.txt', content: 'hi' },
        ctx,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/permission|approval|ZELARI_AUTO/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
