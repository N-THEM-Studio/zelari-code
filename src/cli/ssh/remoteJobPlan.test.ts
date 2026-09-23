/**
 * Unit tests — RemoteJob anti-tamper plan (B6).
 */
import { describe, expect, it } from 'vitest';
import {
  createPlan,
  verifyPlan,
  checkPlanConstraints,
  type RemoteJobPlan,
} from './remoteJobPlan.js';

describe('createPlan', () => {
  it('creates a sealed plan with defaults', () => {
    const plan = createPlan({ type: 'deploy' });
    expect(plan.type).toBe('deploy');
    expect(plan.version).toBe(1);
    expect(plan.data).toEqual({});
    expect(plan.maxOutputBytes).toBe(0);
    expect(plan.seal).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('creates a plan with custom fields', () => {
    const plan = createPlan({
      type: 'build',
      version: 2,
      data: { target: 'production' },
      maxOutputBytes: 8192,
    });
    expect(plan.type).toBe('build');
    expect(plan.version).toBe(2);
    expect(plan.data).toEqual({ target: 'production' });
    expect(plan.maxOutputBytes).toBe(8192);
  });

  it('produces different seals for different types', () => {
    const p1 = createPlan({ type: 'deploy' });
    const p2 = createPlan({ type: 'build' });
    expect(p1.seal).not.toBe(p2.seal);
  });

  it('produces different seals for different data', () => {
    const p1 = createPlan({ type: 'deploy', data: { a: 1 } });
    const p2 = createPlan({ type: 'deploy', data: { a: 2 } });
    expect(p1.seal).not.toBe(p2.seal);
  });

  it('produces different seals for different maxOutputBytes', () => {
    const p1 = createPlan({ type: 'deploy', maxOutputBytes: 1000 });
    const p2 = createPlan({ type: 'deploy', maxOutputBytes: 2000 });
    expect(p1.seal).not.toBe(p2.seal);
  });

  it('plans are frozen (immutable)', () => {
    const plan = createPlan({ type: 'deploy' });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

describe('verifyPlan', () => {
  it('verifies a valid sealed plan', () => {
    const plan = createPlan({ type: 'deploy', data: { cmd: 'ls' } });
    const result = verifyPlan(plan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.type).toBe('deploy');
    }
  });

  it('rejects null input', () => {
    const result = verifyPlan(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_type');
  });

  it('rejects plan with empty type', () => {
    const result = verifyPlan({ type: '', version: 1, seal: 'abc', data: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_type');
  });

  it('rejects plan with invalid version', () => {
    const plan = createPlan({ type: 'deploy' });
    const tampered = { ...plan, version: -1 };
    const result = verifyPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_version');
  });

  it('rejects plan with missing seal', () => {
    const result = verifyPlan({ type: 'deploy', version: 1, data: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('missing_seal');
  });

  it('detects tampered type', () => {
    const plan = createPlan({ type: 'deploy' });
    const tampered = { ...plan, type: 'build' };
    const result = verifyPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('seal_mismatch');
  });

  it('detects tampered data', () => {
    const plan = createPlan({ type: 'deploy', data: { cmd: 'ls' } });
    const tampered = { ...plan, data: { cmd: 'rm -rf /' } };
    const result = verifyPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('seal_mismatch');
  });

  it('detects tampered maxOutputBytes', () => {
    const plan = createPlan({ type: 'deploy', maxOutputBytes: 1000 });
    const tampered = { ...plan, maxOutputBytes: 999999 };
    const result = verifyPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('seal_mismatch');
  });

  it('detects tampered seal', () => {
    const plan = createPlan({ type: 'deploy' });
    const tampered = { ...plan, seal: 'a'.repeat(64) };
    const result = verifyPlan(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('seal_mismatch');
  });

  it('verifies a round-tripped plan (JSON serialize → parse)', () => {
    const plan = createPlan({ type: 'deploy', data: { x: 1 }, maxOutputBytes: 4096 });
    const json = JSON.stringify(plan);
    const parsed = JSON.parse(json);
    const result = verifyPlan(parsed);
    expect(result.ok).toBe(true);
  });
});

describe('checkPlanConstraints', () => {
  it('passes when no constraints set', () => {
    const plan = createPlan({ type: 'deploy' });
    expect(checkPlanConstraints(plan).ok).toBe(true);
  });

  it('passes when type is in allowed list', () => {
    const plan = createPlan({ type: 'deploy' });
    expect(checkPlanConstraints(plan, { allowedTypes: ['deploy', 'build'] }).ok).toBe(true);
  });

  it('fails when type is not in allowed list', () => {
    const plan = createPlan({ type: 'deploy' });
    const result = checkPlanConstraints(plan, { allowedTypes: ['build'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('constraint_violated');
  });

  it('passes when output is under limit', () => {
    const plan = createPlan({ type: 'deploy', maxOutputBytes: 8192 });
    expect(checkPlanConstraints(plan, { actualOutputBytes: 4000 }).ok).toBe(true);
  });

  it('fails when output exceeds limit', () => {
    const plan = createPlan({ type: 'deploy', maxOutputBytes: 100 });
    const result = checkPlanConstraints(plan, { actualOutputBytes: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('constraint_violated');
  });

  it('passes when maxOutputBytes is 0 (no limit)', () => {
    const plan = createPlan({ type: 'deploy', maxOutputBytes: 0 });
    expect(checkPlanConstraints(plan, { actualOutputBytes: 999999 }).ok).toBe(true);
  });
});
