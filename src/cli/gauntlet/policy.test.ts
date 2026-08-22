import { describe, expect, it } from 'vitest';
import { budgetAwareGauntletGate } from './policy.js';

describe('budgetAwareGauntletGate (2.6.1 zero-budget fix, plan §16/§27)', () => {
  it('zero budget → hold (never finalize-verify with nothing to spend)', () => {
    expect(budgetAwareGauntletGate({ verdict: 'GAP', toolCallsRemaining: 0, verificationReserve: 6 })).toBe('hold');
    expect(budgetAwareGauntletGate({ verdict: 'BLOCKED', toolCallsRemaining: 0, verificationReserve: 6 })).toBe('hold');
  });

  it('1 call left inside the reserve → finalize-verify', () => {
    expect(budgetAwareGauntletGate({ verdict: 'GAP', toolCallsRemaining: 1, verificationReserve: 6 })).toBe(
      'finalize-verify',
    );
  });

  it('GAP with ample budget → proceed (repair)', () => {
    expect(budgetAwareGauntletGate({ verdict: 'GAP', toolCallsRemaining: 20, verificationReserve: 6 })).toBe('proceed');
  });

  it('PASS verdict proceeds regardless of budget (completion is verdict-driven)', () => {
    expect(budgetAwareGauntletGate({ verdict: 'PASS', toolCallsRemaining: 0, verificationReserve: 6 })).toBe('proceed');
    expect(budgetAwareGauntletGate({ verdict: 'PASS', toolCallsRemaining: 30, verificationReserve: 6 })).toBe('proceed');
  });

  it('exactly the reserve boundary → finalize-verify', () => {
    expect(budgetAwareGauntletGate({ verdict: 'GAP', toolCallsRemaining: 6, verificationReserve: 6 })).toBe(
      'finalize-verify',
    );
  });
});
