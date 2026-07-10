import { describe, it, expect } from 'vitest';
import {
  parsePhase,
  nextPhase,
  describePhase,
  PLAN_BLOCKED_TOOLS,
  PLAN_ALLOWED_WRITE_TOOLS,
} from '../../src/cli/phase.js';

describe('phase', () => {
  it('parses plan/build', () => {
    expect(parsePhase('plan')).toBe('plan');
    expect(parsePhase('BUILD')).toBe('build');
    expect(parsePhase('nope')).toBeNull();
  });

  it('cycles plan ↔ build', () => {
    expect(nextPhase('plan')).toBe('build');
    expect(nextPhase('build')).toBe('plan');
  });

  it('describes phases', () => {
    expect(describePhase('plan')).toMatch(/plan/i);
    expect(describePhase('build')).toMatch(/build/i);
  });

  it('blocks mutating builtins in plan phase', () => {
    expect(PLAN_BLOCKED_TOOLS.has('write_file')).toBe(true);
    expect(PLAN_BLOCKED_TOOLS.has('edit_file')).toBe(true);
    expect(PLAN_BLOCKED_TOOLS.has('bash')).toBe(true);
    expect(PLAN_ALLOWED_WRITE_TOOLS.has('createPlan')).toBe(true);
  });
});
