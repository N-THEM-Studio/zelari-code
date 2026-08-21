import { describe, expect, it } from 'vitest';
import { parseGauntletVerdict } from '../../src/cli/gauntlet/verdict.js';

describe('parseGauntletVerdict', () => {
  it('honours an explicit PASS only when the critic ran tools', () => {
    expect(
      parseGauntletVerdict('Looks good.\nVERDICT: PASS', { toolTraceCount: 2 }),
    ).toEqual({ kind: 'PASS', evidence: true });
  });

  it('downgrades PASS without tool evidence (unknown ≠ pass)', () => {
    const v = parseGauntletVerdict('VERDICT: PASS', { toolTraceCount: 0 });
    expect(v.kind).toBe('GAP');
    expect(v.evidence).toBe(false);
    expect(v.gap).toMatch(/unknown ≠ pass/i);
  });

  it('reads GAP trailer', () => {
    const v = parseGauntletVerdict(
      'VERDICT: GAP\nGAP: missing HUD timer\n',
      { toolTraceCount: 1 },
    );
    expect(v).toEqual({
      kind: 'GAP',
      gap: 'missing HUD timer',
      evidence: true,
    });
  });

  it('treats a failing verify-report as GAP', () => {
    const v = parseGauntletVerdict(
      ['<verify-report>', 'check: tsc', 'status: fail', 'note: 3 errors', '</verify-report>'].join(
        '\n',
      ),
      { toolTraceCount: 1 },
    );
    expect(v.kind).toBe('GAP');
    expect(v.evidence).toBe(true);
  });

  it('maps a failed builder to GAP even if the critic is silent', () => {
    const v = parseGauntletVerdict('', {
      builderFailed: true,
      builderError: 'task: sub-agent cancelled',
    });
    expect(v.kind).toBe('GAP');
    expect(v.gap).toMatch(/cancelled/);
  });

  it('BLOCKED on empty critic output', () => {
    expect(parseGauntletVerdict('   ')).toMatchObject({ kind: 'BLOCKED', evidence: false });
  });
});
