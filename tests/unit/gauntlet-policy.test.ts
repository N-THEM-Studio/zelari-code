import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinToolRegistry } from '../../src/cli/toolRegistry.js';
import { AuditLogger } from '../../src/cli/safety/auditLogger.js';
import { defaultPermissionPolicy } from '../../src/cli/safety/toolPermissions.js';
import {
  DEFAULT_WALL_MS,
  GAUNTLET_PARENT_BLOCKED_TOOLS,
  isGauntletFlagOn,
  resolveGauntletCaps,
  shouldRunGauntletHostLoop,
} from '../../src/cli/gauntlet/policy.js';

describe('gauntlet policy', () => {
  it('isGauntletFlagOn prefers the explicit flag over env', () => {
    expect(isGauntletFlagOn(true, {})).toBe(true);
    expect(isGauntletFlagOn(false, { ZELARI_GAUNTLET: '1' })).toBe(false);
    expect(isGauntletFlagOn(undefined, { ZELARI_GAUNTLET: '1' })).toBe(true);
    expect(isGauntletFlagOn(undefined, {})).toBe(false);
  });

  it('host loop is BUILD kraken only', () => {
    expect(shouldRunGauntletHostLoop({ gauntlet: true, phase: 'build' })).toBe(true);
    expect(shouldRunGauntletHostLoop({ gauntlet: true, phase: 'plan' })).toBe(false);
    expect(
      shouldRunGauntletHostLoop({ gauntlet: true, krakenGraph: 'do it', phase: 'build' }),
    ).toBe(false);
    expect(shouldRunGauntletHostLoop({ gauntlet: true, mode: 'council' })).toBe(false);
  });

  it('defaults wall clock to 45 minutes; 0 disables', () => {
    expect(resolveGauntletCaps({}).wallClockMs).toBe(DEFAULT_WALL_MS);
    expect(resolveGauntletCaps({ ZELARI_GAUNTLET_WALL_MS: '0' }).wallClockMs).toBe(0);
    expect(resolveGauntletCaps({ ZELARI_GAUNTLET_WALL_MS: '120000' }).wallClockMs).toBe(120000);
  });
});

describe('gauntlet parent registry', () => {
  it('keeps task and observe tools, strips mutators', () => {
    const { registry } = createBuiltinToolRegistry({
      root: path.join(tmpdir(), 'gauntlet-reg'),
      audit: new AuditLogger(path.join(tmpdir(), `gauntlet-audit-${Date.now()}.log`)),
      permissionPolicy: defaultPermissionPolicy({ auto: true }),
      lifecycleHooks: null,
      lspProvider: null,
      gauntletParent: true,
    });
    const names = new Set(registry.list());
    expect(names.has('task')).toBe(true);
    expect(names.has('read_file')).toBe(true);
    expect(names.has('list_files')).toBe(true);
    for (const blocked of GAUNTLET_PARENT_BLOCKED_TOOLS) {
      expect(names.has(blocked), blocked).toBe(false);
    }
  });
});
