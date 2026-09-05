import { describe, expect, it } from 'vitest';
import {
  applyTurnPermissionPreset,
  createServePermissionBridge,
  servePermissionRespond,
} from '../../src/cli/serve/permissionBridge.js';

describe('applyTurnPermissionPreset (run.turn permissionPreset field)', () => {
  it('applies an allowlisted preset to the preset engine env', () => {
    const before = process.env.ZELARI_PERMISSION_PRESET;
    try {
      expect(applyTurnPermissionPreset({ permissionPreset: 'strict' })).toBe(true);
      expect(process.env.ZELARI_PERMISSION_PRESET).toBe('strict');
      expect(applyTurnPermissionPreset({ permissionPreset: 'YOLO ' })).toBe(true);
      expect(process.env.ZELARI_PERMISSION_PRESET).toBe('yolo');
    } finally {
      restore(before);
    }
  });

  it('rejects unknown presets (no arbitrary env injection over the wire)', () => {
    const before = process.env.ZELARI_PERMISSION_PRESET;
    try {
      expect(applyTurnPermissionPreset({ permissionPreset: 'allow-all-pls' })).toBe(false);
      expect(applyTurnPermissionPreset({ permissionPreset: '' })).toBe(false);
      expect(applyTurnPermissionPreset({})).toBe(false);
      expect(applyTurnPermissionPreset(null)).toBe(false);
      expect(process.env.ZELARI_PERMISSION_PRESET).toBe(before ?? undefined);
    } finally {
      restore(before);
    }
  });
});

describe('createServePermissionBridge (ask over NDJSON, fail-closed)', () => {
  it('emits a permission.request event and resolves on respond(allow)', async () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const decision = bridge.onPermissionAsk({
      tool: 'bash',
      category: 'execute',
      inputPreview: 'npm test',
    });
    expect(bridge.pendingCount()).toBe(1);
    const event = JSON.parse(lines[0]!) as { type: string; requestId: string; tool: string };
    expect(event.type).toBe('permission.request');
    expect(event.tool).toBe('bash');
    expect(bridge.respond(event.requestId, 'allow')).toBe(true);
    await expect(decision).resolves.toBe('allow');
    expect(bridge.pendingCount()).toBe(0);
  });

  it('DENIES when the host never answers (fail-closed, never allow)', async () => {
    const bridge = createServePermissionBridge(() => {}, 10);
    const decision = bridge.onPermissionAsk({ tool: 'bash', category: 'execute' });
    await expect(decision).resolves.toBe('deny');
    expect(bridge.pendingCount()).toBe(0);
  });

  it('respond is idempotent for unknown/duplicate ids', () => {
    const bridge = createServePermissionBridge(() => {}, 60_000);
    expect(bridge.respond('nope', 'allow')).toBe(false);
  });
});

describe('servePermissionRespond (dispatch method contract)', () => {
  const bridge = createServePermissionBridge(() => {}, 60_000);

  it('validates params shape', () => {
    expect(servePermissionRespond(bridge, null).accepted).toBe(false);
    expect(servePermissionRespond(bridge, {}).accepted).toBe(false);
    expect(
      servePermissionRespond(bridge, { requestId: 'x', decision: 'maybe' }).accepted,
    ).toBe(false);
  });

  it('reports unknown request ids as not accepted (no fake ok)', () => {
    const res = servePermissionRespond(bridge, { requestId: 'ghost', decision: 'deny' });
    expect(res.accepted).toBe(false);
  });
});

function restore(before: string | undefined): void {
  if (before === undefined) delete process.env.ZELARI_PERMISSION_PRESET;
  else process.env.ZELARI_PERMISSION_PRESET = before;
}
