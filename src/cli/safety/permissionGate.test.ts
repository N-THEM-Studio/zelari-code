/**
 * ADR-0039 P3b (t149) — the permission-event layer AFTER engine A's removal.
 * Engine-A evaluation (evaluateToolDispatch/applyAllowRule) is gone; what
 * remains is the spine-event contract: which layer a deny names, which allow
 * is worth recording, and the payload guard.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_APPROVE_GRANTED_KIND,
  PERMISSION_ASKED_KIND,
  PERMISSION_DENIED_KIND,
  autoApproveOrigin,
  buildPermissionRequest,
  denyOriginFor,
  emitAutoApproveGranted,
  emitPermissionDenied,
} from './permissionGate.js';

describe('ADR-0039 P3b — permission spine events (engine A removed)', () => {
  it('buildPermissionRequest still derives paths from the claims table', () => {
    const req = buildPermissionRequest({
      toolName: 'write_file',
      required: ['write'],
      args: { path: 'a.ts' },
      root: process.cwd(),
    });
    expect(req.paths).toContain('a.ts');
  });

  it('denyOriginFor names the engine-B rule that denied; category is the floor', () => {
    expect(
      denyOriginFor({ rule: { match: 'secrets/**', effect: 'deny', reason: 'no secrets' } }),
    ).toEqual({ source: 'policy', matchedRuleId: 'secrets/**', reason: 'no secrets' });
    expect(denyOriginFor({ categoryReason: 'write=deny default' })).toEqual({
      source: 'default',
      reason: 'write=deny default',
    });
  });

  it('autoApproveOrigin records yolo and privileged categories; never the read/write flood', () => {
    expect(autoApproveOrigin({ effect: 'allow', categories: ['execute'] })).toEqual({
      source: 'default',
      reason: 'execute category default',
    });
    expect(autoApproveOrigin({ effect: 'allow', categories: ['read'], yoloPromoted: true })?.source).toBe('preset');
    expect(autoApproveOrigin({ effect: 'allow', categories: ['read'] })).toBeNull();
  });

  it('emitPermissionDenied writes the event naming the deciding layer', async () => {
    const sink = vi.fn().mockResolvedValue({ seq: 7 });
    const res = await emitPermissionDenied(sink, {
      tool: 'write_file',
      origin: { source: 'policy', matchedRuleId: 'secrets/**' },
    });
    expect(res).toEqual({ recorded: true, seq: 7 });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: PERMISSION_DENIED_KIND }));
  });

  it('emitPermissionDenied DROPS a deny that names no deciding layer (never invents one)', async () => {
    const sink = vi.fn();
    const res = await emitPermissionDenied(sink, { tool: 'write_file' });
    expect(res.recorded).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it('ask/auto-approve event kinds are still exported for the registry', () => {
    expect(PERMISSION_ASKED_KIND).toBe('permission.asked');
    expect(AUTO_APPROVE_GRANTED_KIND).toBe('auto_approve.granted');
  });

  it('emitAutoApproveGranted records the origin', async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    await emitAutoApproveGranted(sink, {
      tool: 'bash',
      categories: ['execute'],
      origin: { source: 'default', reason: 'execute category default' },
    });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: AUTO_APPROVE_GRANTED_KIND }));
  });
});
