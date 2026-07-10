import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  estimateTokens,
  estimateHistoryTokens,
  applyBudgetPolicy,
  resolveContextLimit,
} from '../../src/cli/budget/tokenBudget.js';
import type { AgentMessage } from '@zelari/core/harness';

const REAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...REAL_ENV };
  delete process.env.ZELARI_CONTEXT_LIMIT;
  delete process.env.ZELARI_HISTORY_TURNS;
  delete process.env.ZELARI_MAX_TOOL_LOOP_ITERATIONS;
});

afterEach(() => {
  process.env = { ...REAL_ENV };
});

function msg(role: AgentMessage['role'], content: string): AgentMessage {
  return { role, content };
}

describe('tokenBudget', () => {
  it('estimates tokens from chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('resolveContextLimit honors env', () => {
    process.env.ZELARI_CONTEXT_LIMIT = '50000';
    expect(resolveContextLimit()).toBe(50000);
  });

  it('warns at ~70% occupancy', () => {
    // min clamp on ZELARI_CONTEXT_LIMIT is 4000.
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    // 70% of 4000 = 2800 tokens → 2800*4 = 11200 chars.
    const history: AgentMessage[] = [msg('user', 'x'.repeat(11200))];
    const policy = applyBudgetPolicy(history, 'build');
    expect(policy.occupancy).toBeGreaterThanOrEqual(0.7);
    expect(policy.warnings.some((w) => w.includes('context') || w.includes('%'))).toBe(true);
  });

  it('auto-compacts at high occupancy', () => {
    process.env.ZELARI_CONTEXT_LIMIT = '4000';
    // Need >> 85% of 4000 tokens (~3400). Each turn ~100+100 tokens.
    const history: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      history.push(msg('user', `u${i} ` + 'y'.repeat(400)));
      history.push(msg('assistant', `a${i} ` + 'z'.repeat(400)));
    }
    const before = estimateHistoryTokens(history);
    expect(before).toBeGreaterThan(3400);
    const policy = applyBudgetPolicy(history, 'build');
    expect(policy.estimatedHistoryTokens).toBeLessThan(before);
    expect(policy.history.length).toBeLessThan(history.length);
    expect(policy.warnings.some((w) => /auto-compact|HARD/i.test(w))).toBe(true);
  });

  it('plan phase defaults to lower tool-loop than build when env unset', () => {
    process.env.ZELARI_CONTEXT_LIMIT = '200000';
    const empty: AgentMessage[] = [];
    const plan = applyBudgetPolicy(empty, 'plan');
    const build = applyBudgetPolicy(empty, 'build');
    expect(plan.maxToolLoopIterations).toBeLessThanOrEqual(build.maxToolLoopIterations);
  });
});
