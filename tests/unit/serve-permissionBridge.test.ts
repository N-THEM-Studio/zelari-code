import { describe, expect, it, afterEach } from 'vitest';
import {
  applyTurnPermissionPreset,
  asRegistryAskHandler,
  createServePermissionBridge,
  servePermissionRespond,
} from '../../src/cli/serve/permissionBridge.js';
import {
  clearSessionPermissionGrants,
  isSessionGranted,
} from '../../src/cli/safety/toolPermissions.js';

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
    const settled = JSON.parse(lines[1]!) as { type: string; decision: string };
    expect(settled.type).toBe('permission.settled');
    expect(settled.decision).toBe('allow');
  });

  it('emits categories on the request event', async () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const pending = bridge.onPermissionAsk({
      tool: 'bash',
      category: 'execute',
      categories: ['execute'],
    });
    const event = JSON.parse(lines[0]!) as { categories?: string[] };
    expect(event.categories).toEqual(['execute']);
    bridge.respond(JSON.parse(lines[0]!).requestId, 'deny');
    await pending;
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

  it('accepts always-tool / always-category decisions', async () => {
    const lines: string[] = [];
    const live = createServePermissionBridge((l) => lines.push(l), 60_000);
    const pending = live.onPermissionAsk({ tool: 'bash', category: 'execute' });
    const id = (JSON.parse(lines[0]!) as { requestId: string }).requestId;
    expect(
      servePermissionRespond(live, { requestId: id, decision: 'always-tool' }).accepted,
    ).toBe(true);
    await expect(pending).resolves.toBe('always-tool');
  });

  it('reports unknown request ids as not accepted (no fake ok)', () => {
    const res = servePermissionRespond(bridge, { requestId: 'ghost', decision: 'deny' });
    expect(res.accepted).toBe(false);
  });
});

describe('asRegistryAskHandler (session grants)', () => {
  afterEach(() => clearSessionPermissionGrants());

  it('always-tool grants the tool for this sidecar session', async () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const handler = asRegistryAskHandler(bridge);
    const pending = handler({
      toolName: 'bash',
      reason: 'execute',
      categories: ['execute'],
      args: {},
    });
    const id = (JSON.parse(lines[0]!) as { requestId: string }).requestId;
    expect(bridge.respond(id, 'always-tool')).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(isSessionGranted('bash', ['execute'])).toBe(true);
  });

  it('always-category auto-allows sibling in-flight asks (parallel tentacles)', async () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const handler = asRegistryAskHandler(bridge);
    const a = handler({
      toolName: 'task',
      reason: 'execute',
      categories: ['execute', 'network'],
      args: {},
    });
    const b = handler({
      toolName: 'task',
      reason: 'execute',
      categories: ['execute', 'network'],
      args: {},
    });
    const c = handler({
      toolName: 'task',
      reason: 'execute',
      categories: ['execute', 'network'],
      args: {},
    });
    expect(bridge.pendingCount()).toBe(3);
    const firstId = (JSON.parse(lines[0]!) as { requestId: string }).requestId;
    expect(bridge.respond(firstId, 'always-category')).toBe(true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    await expect(c).resolves.toBe(true);
    expect(bridge.pendingCount()).toBe(0);
    expect(isSessionGranted('task', ['execute', 'network'])).toBe(true);
  });

  it('deny does not grant', async () => {
    const lines: string[] = [];
    const bridge = createServePermissionBridge((l) => lines.push(l), 60_000);
    const handler = asRegistryAskHandler(bridge);
    const pending = handler({
      toolName: 'bash',
      reason: 'execute',
      categories: ['execute'],
      args: {},
    });
    const id = (JSON.parse(lines[0]!) as { requestId: string }).requestId;
    expect(bridge.respond(id, 'deny')).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(isSessionGranted('bash', ['execute'])).toBe(false);
  });
});

function restore(before: string | undefined): void {
  if (before === undefined) delete process.env.ZELARI_PERMISSION_PRESET;
  else process.env.ZELARI_PERMISSION_PRESET = before;
}
