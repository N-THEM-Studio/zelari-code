/**
 * tools/eval/antiGoodhart.test.ts — W2/t45 unit tests: behavioural rule,
 * seal/verify roundtrip, and the decide() behavioural gate.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  behavioralMetrics,
  behavioralVerdict,
  readLedgerFile,
  rotationCandidates,
  splitByTime,
  tierWeight,
  type BehavioralMetrics,
  type LedgerLikeEntry,
} from './behavioral.ts';
import { decide } from './evolveDecide.ts';
import type { StoredProposal } from './evolvePropose.ts';
type StoredProposalLike = StoredProposal;
import {
  computeSealManifest,
  listAnchorFiles,
  readSealManifest,
  sealManifestHash,
  unsealIds,
  verifySeal,
  writeSealManifest,
} from './sealedAnchors.ts';

const e = (over: Partial<LedgerLikeEntry>): LedgerLikeEntry => ({ at: '2026-01-01T00:00:00Z', verdict: 'PASS', evidenceTier: 'build', ...over });

describe('tierWeight (parity with src/cli/evolution/ledger.ts)', () => {
  it('keeps the documented weights', () => {
    expect(tierWeight('build')).toBe(1);
    expect(tierWeight('tool-output')).toBe(1);
    expect(tierWeight('command-output')).toBe(1);
    expect(tierWeight('fs-observation')).toBe(0.9);
    expect(tierWeight('verifier-llm')).toBe(0.25);
    expect(tierWeight(undefined)).toBe(0.25);
    expect(tierWeight('whatever-else')).toBe(0.25);
  });
});

describe('behavioralMetrics / splitByTime', () => {
  it('computes means over the right slices', () => {
    const m = behavioralMetrics([
      e({ verdict: 'PASS', steerCount: 1, evidenceTier: 'build' }),
      e({ verdict: 'FAIL', steerCount: 3, evidenceTier: 'fs-observation', rollbackUsed: true }),
      e({ verdict: 'HOLD', rollbackUsed: true }),
    ]);
    expect(m.runs).toBe(3);
    expect(m.ratedRuns).toBe(2);
    expect(m.avgSteerCount).toBe(2);
    expect(m.avgTierWeight).toBeCloseTo(0.95, 9);
    expect(m.rollbackRate).toBeCloseTo(2 / 3, 9);
  });

  it('splits with the boundary going to the variant side', () => {
    const since = '2026-06-01T00:00:00Z';
    const { before, after } = splitByTime(
      [e({ at: '2026-05-31T23:59:59Z' }), e({ at: since }), e({ at: '2026-06-02T00:00:00Z' })],
      since,
    );
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it('reads the ledger tolerantly (missing file, corrupt lines)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-behavioral-'));
    try {
      const file = path.join(dir, 'ledger.jsonl');
      expect(readLedgerFile(path.join(dir, 'missing.jsonl'))).toEqual([]);
      writeFileSync(file, `${JSON.stringify(e({ at: '2026-01-01T00:00:00Z' }))}\nnot-json\n\n`, 'utf8');
      expect(readLedgerFile(file)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('behavioralVerdict (the anti-Goodhart rule, docs/EVALS.md #2)', () => {
  const base = (over: Partial<BehavioralMetrics> = {}): BehavioralMetrics => ({ runs: 5, ratedRuns: 5, avgSteerCount: 0.5, avgTierWeight: 1, rollbackRate: 0, ...over });

  it('rejects a steer/interrupt regression', () => {
    const v = behavioralVerdict(base(), base({ avgSteerCount: 1.2 }));
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain('steer/interrupt rate rose');
  });

  it('rejects an evidence-tier regression even when pass rate improves', () => {
    const v = behavioralVerdict(base(), base({ avgTierWeight: 0.6 }));
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain('average evidence tier fell');
  });

  it('passes an improvement with empty reasons', () => {
    const v = behavioralVerdict(base(), base({ avgSteerCount: 0.2, avgTierWeight: 1 }));
    expect(v).toMatchObject({ ok: true, reasons: [] });
  });

  it('skips (never guesses) below minRuns', () => {
    const v = behavioralVerdict(base({ ratedRuns: 2 }), base());
    expect(v.ok).toBe(true);
    expect(v.skipped).toContain('not computable');
  });
});

describe('rotationCandidates', () => {
  it('ranks classes by fail+hold, ties by name', () => {
    const c = rotationCandidates(
      [
        e({ taskClass: 'a', verdict: 'FAIL' }),
        e({ taskClass: 'a', verdict: 'PASS' }),
        e({ taskClass: 'b', verdict: 'HOLD' }),
        e({ taskClass: 'b', verdict: 'HOLD' }),
        e({ taskClass: 'c', verdict: 'PASS' }),
      ],
      2,
    );
    expect(c.map((x) => x.taskClass)).toEqual(['b', 'a']);
    expect(c[0]).toMatchObject({ failHold: 2, total: 2 });
  });
});

describe('sealedAnchors roundtrip', () => {
  const anchorJson = (id: string, tier: number) =>
    `${JSON.stringify({ id, version: 1, tier, profile: 'kraken/v1', phase: 'build', task: `task ${id}`, success: [{ command: 'true' }], budget: { maxToolCalls: 10 } }, null, 2)}\n`;

  it('seals, verifies, detects drift, unseals', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-seal-'));
    try {
      mkdirSync(path.join(dir, 'grp'), { recursive: true });
      writeFileSync(path.join(dir, 'grp', 'one.anchor.json'), anchorJson('one', 0), 'utf8');
      writeFileSync(path.join(dir, 'grp', 'two.anchor.json'), anchorJson('two', 1), 'utf8');
      expect(listAnchorFiles(dir).map((f) => f.id)).toEqual(['one', 'two']);

      const m1 = computeSealManifest(dir, ['one'], '2026-09-04T00:00:00Z', null);
      expect(m1.anchors).toHaveLength(1);
      // idempotent re-seal of the same bytes
      const m2 = computeSealManifest(dir, ['one', 'two'], '2026-09-04T00:00:00Z', m1);
      expect(m2.anchors.map((a) => a.id)).toEqual(['one', 'two']);
      expect(verifySeal(dir, m2).ok).toBe(true);

      // drift: change sealed bytes -> verify fails
      writeFileSync(path.join(dir, 'grp', 'one.anchor.json'), anchorJson('one', 0) + '\n', 'utf8');
      const drifted = verifySeal(dir, m2);
      expect(drifted.ok).toBe(false);
      expect(drifted.problems[0]).toContain('DRIFTED');
      // computeSealManifest refuses to re-seal drifted content silently
      expect(() => computeSealManifest(dir, ['one'], '2026-09-05T00:00:00Z', m2)).toThrow(/different content hash/);

      const m3 = unsealIds(m2, ['one']);
      expect(m3.anchors.map((a) => a.id)).toEqual(['two']);
      expect(() => unsealIds(m3, ['one'])).toThrow(/not sealed/);
      expect(typeof sealManifestHash(m3)).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes and re-reads the manifest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zelari-sealw-'));
    try {
      writeFileSync(path.join(dir, 'x.anchor.json'), anchorJson('x', 0), 'utf8');
      const m = computeSealManifest(dir, ['x'], '2026-09-04T00:00:00Z', null);
      const file = path.join(dir, 'sealed.json');
      writeSealManifest(file, m);
      expect(readSealManifest(file)?.anchors[0]?.id).toBe('x');
      expect(readSealManifest(path.join(dir, 'nope.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('decide() behavioural gate (applied only)', () => {
  const proposal: StoredProposalLike = {
    id: 'p-0001',
    createdAt: '2026-06-01T00:00:00Z',
    requiredValidation: ['run tests'],
  };

  it('blocks applied on a steer regression', () => {
    expect(() =>
      decide([proposal as never], {
        id: 'p-0001',
        status: 'applied',
        ref: 'abc123',
        evidence: ['npm test … exit 0'],
        behavior: {
          baseline: { runs: 5, ratedRuns: 5, avgSteerCount: 0.2, avgTierWeight: 1, rollbackRate: 0 },
          variant: { runs: 5, ratedRuns: 5, avgSteerCount: 1.4, avgTierWeight: 1, rollbackRate: 0 },
        },
      }, '2026-09-04T00:00:00Z'),
    ).toThrow(/behavioural rule/);
  });

  it('records applied when behaviour improves', () => {
    const r = decide([proposal as never], {
      id: 'p-0001',
      status: 'applied',
      ref: 'abc123',
      evidence: ['npm test … exit 0'],
      behavior: {
        baseline: { runs: 5, ratedRuns: 5, avgSteerCount: 1, avgTierWeight: 0.6, rollbackRate: 0 },
        variant: { runs: 5, ratedRuns: 5, avgSteerCount: 0.5, avgTierWeight: 1, rollbackRate: 0 },
      },
    }, '2026-09-04T00:00:00Z');
    expect(r.outcome).toBe('appended');
  });

  it('stays back-compatible without behaviour data', () => {
    const r = decide([proposal as never], {
      id: 'p-0001',
      status: 'applied',
      ref: 'abc123',
      evidence: ['npm test … exit 0'],
    }, '2026-09-04T00:00:00Z');
    expect(r.outcome).toBe('appended');
  });
});
