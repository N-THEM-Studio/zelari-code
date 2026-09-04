import { describe, expect, it } from 'vitest';
import { decayedConfidence, decayReport, detectContradictions, type AuditNode } from './audit.js';

const NOW = new Date('2026-09-04T12:00:00Z');

function node(overrides: Partial<AuditNode> & Pick<AuditNode, 'id' | 'content'>): AuditNode {
  return {
    kind: 'fact',
    confidence: 0.8,
    status: 'active',
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('decayedConfidence', () => {
  it('keeps full confidence when freshly updated', () => {
    const n = node({ id: 'a', content: 'x', updatedAt: NOW.toISOString() });
    expect(decayedConfidence(n, NOW)).toBeCloseTo(0.8, 6);
  });

  it('halves confidence after one half-life (30 days)', () => {
    const n = node({ id: 'a', content: 'x', updatedAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });
    expect(decayedConfidence(n, NOW)).toBeCloseTo(0.4, 6);
  });

  it('quarters after two half-lives', () => {
    const n = node({ id: 'a', content: 'x', updatedAt: new Date(NOW.getTime() - 60 * 86_400_000).toISOString() });
    expect(decayedConfidence(n, NOW)).toBeCloseTo(0.2, 6);
  });

  it('never decays below the floor', () => {
    const n = node({ id: 'a', content: 'x', updatedAt: new Date(NOW.getTime() - 3650 * 86_400_000).toISOString() });
    expect(decayedConfidence(n, NOW)).toBeCloseTo(0.05, 6);
  });

  it('falls back to declared confidence on unparsable timestamps', () => {
    const n = node({ id: 'a', content: 'x', updatedAt: 'not-a-date' });
    expect(decayedConfidence(n, NOW)).toBe(0.8);
  });
});

describe('detectContradictions', () => {
  it('flags mirror-negation pairs on the same subject', () => {
    const nodes = [
      node({ id: 'n1', content: 'the api base path is /v1' }),
      node({ id: 'n2', content: 'the api base path is not /v1' }),
    ];
    const pairs = detectContradictions(nodes);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'n1', b: 'n2', reason: 'mirror-negation' });
  });

  it('does not flag two affirmative statements on the same subject', () => {
    const nodes = [
      node({ id: 'n1', content: 'the api base path is /v1' }),
      node({ id: 'n2', content: 'the api base path is /v2' }),
    ];
    expect(detectContradictions(nodes)).toHaveLength(0);
  });

  it('ignores non-contradictable kinds and retracted nodes', () => {
    const nodes = [
      node({ id: 'n1', kind: 'observation', content: 'tests pass' }),
      node({ id: 'n2', kind: 'observation', content: 'tests do not pass' }),
      node({ id: 'n3', content: 'x', status: 'retracted' }),
      node({ id: 'n4', content: 'x is not y', status: 'retracted' }),
    ];
    expect(detectContradictions(nodes)).toHaveLength(0);
  });

  it('keeps subject matching stable across negation position', () => {
    const nodes = [
      node({ id: 'n1', content: 'hooks are fail-open by default' }),
      node({ id: 'n2', content: 'hooks are not fail-open by default' }),
    ];
    expect(detectContradictions(nodes)).toHaveLength(1);
  });
});

describe('decayReport', () => {
  it('lists only materially decayed active nodes, worst first', () => {
    const nodes = [
      node({ id: 'fresh', content: 'x', updatedAt: NOW.toISOString() }),
      node({ id: 'old30', content: 'x', updatedAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() }),
      node({ id: 'old90', content: 'x', updatedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() }),
      node({ id: 'retracted', content: 'x', status: 'retracted', updatedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() }),
    ];
    const report = decayReport(nodes, NOW);
    expect(report.map((r) => r.id)).toEqual(['old90', 'old30']);
    expect(report[0].effective).toBeLessThan(report[0].declared);
  });
});
