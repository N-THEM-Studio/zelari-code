import { afterEach, describe, expect, it } from 'vitest';
import {
  collectKrakenTurnMetrics,
  markRepairSucceeded,
  markRepairTriggered,
  recordCandidateTokens,
  recordSelectionOutcome,
  resetKrakenTurnMetrics,
} from './metrics.js';
import {
  registerCandidate,
  resetKrakenCandidates,
  setKrakenCheckResults,
  setKrakenSelection,
} from './candidateRegistry.js';
import type { KrakenSelectionVerdict } from './verifier.js';
import type { KrakenCheckResult } from './verifyReport.js';

function verdict(partial: Partial<KrakenSelectionVerdict>): KrakenSelectionVerdict {
  return {
    status: 'selected',
    winnerIndex: 1,
    rationale: 'test',
    requiredChecks: [],
    degraded: false,
    verifier: null,
    judgedBy: 'deterministic',
    ...partial,
  };
}

function check(check: string, status: KrakenCheckResult['status']): KrakenCheckResult {
  return { check, status };
}

afterEach(() => {
  resetKrakenCandidates();
  resetKrakenTurnMetrics();
});

describe('collectKrakenTurnMetrics — null when no selection activity', () => {
  it('returns null on a plain turn (flag off ⇒ zero telemetry)', () => {
    resetKrakenCandidates();
    resetKrakenTurnMetrics();
    expect(collectKrakenTurnMetrics()).toBeNull();
  });

  it('returns null when only unrelated counters were touched', () => {
    recordCandidateTokens(0); // ignored by the guard
    expect(collectKrakenTurnMetrics()).toBeNull();
  });
});

describe('candidate counters', () => {
  it('counts registered candidates (ok and malformed both cost)', () => {
    registerCandidate({
      status: 'ok',
      description: 'h1',
      report: {
        hypothesis: 'h1',
        evidence: [{ claim: 'observed', basis: 'src/x.ts:10', degraded: false }],
        risks: [],
        hasDegradedEvidence: false,
      },
      raw: '',
    });
    registerCandidate({ status: 'malformed', description: 'h2', error: 'bad', raw: '' });
    const m = collectKrakenTurnMetrics();
    expect(m?.candidateCount).toBe(2);
    expect(m?.selectionUsed).toBe(false); // no kraken_select yet
  });

  it('sums provider-reported candidate tokens, ignoring junk', () => {
    registerCandidate({
      status: 'ok',
      description: 'h1',
      report: {
        hypothesis: 'h1',
        evidence: [],
        risks: [],
        hasDegradedEvidence: false,
      },
      raw: '',
    });
    recordCandidateTokens(1200);
    recordCandidateTokens(800.4); // rounded
    recordCandidateTokens(-5); // ignored
    recordCandidateTokens(Number.NaN); // ignored
    const m = collectKrakenTurnMetrics();
    expect(m?.candidateTokens).toBe(2000);
  });
});

describe('selection counters', () => {
  it('records latency/tokens/fallback from the judging call', () => {
    recordSelectionOutcome({ latencyMs: 1500, tokens: 900, degraded: false });
    const m = collectKrakenTurnMetrics();
    expect(m?.selectionLatencyMs).toBe(1500);
    expect(m?.selectionTokens).toBe(900);
    expect(m?.selectionFallback).toBe(false);
  });

  it('keeps tokens undefined when the provider reports none', () => {
    recordSelectionOutcome({ latencyMs: 200, degraded: true, fallbackReason: 'verifier call failed' });
    const m = collectKrakenTurnMetrics();
    expect(m?.selectionTokens).toBeUndefined();
    expect(m?.selectionFallback).toBe(true);
    expect(m?.selectionFallbackReason).toBe('verifier call failed');
  });

  it('flags needs_more_evidence from the persisted verdict', () => {
    setKrakenSelection(verdict({ status: 'needs_more_evidence', winnerIndex: null }));
    const m = collectKrakenTurnMetrics();
    expect(m?.selectionUsed).toBe(true);
    expect(m?.needsMoreEvidence).toBe(true);
  });
});

describe('verification counters', () => {
  it('classifies pass/fail/unknown from registry state', () => {
    setKrakenSelection(verdict({ requiredChecks: ['tests pass', 'build clean', 'lint clean'] }));
    setKrakenCheckResults([
      check('tests pass', 'pass'),
      check('build clean', 'fail'),
      // 'lint clean' unreported ⇒ unknown
    ]);
    const m = collectKrakenTurnMetrics();
    expect(m?.verificationPass).toBe(1);
    expect(m?.verificationFail).toBe(1);
    expect(m?.verificationUnknown).toBe(1);
  });

  it('reports zero verification counters before any verify tentacle', () => {
    setKrakenSelection(verdict({ requiredChecks: ['tests pass'] }));
    const m = collectKrakenTurnMetrics();
    expect(m?.verificationPass).toBe(0);
    expect(m?.verificationUnknown).toBe(1);
  });
});

describe('repair flags', () => {
  it('tracks triggered and success independently', () => {
    markRepairTriggered();
    let m = collectKrakenTurnMetrics();
    expect(m?.repairTriggered).toBe(true);
    expect(m?.repairSucceeded).toBe(false);

    markRepairSucceeded();
    m = collectKrakenTurnMetrics();
    expect(m?.repairSucceeded).toBe(true);
  });

  it('success without trigger is ignored (defensive)', () => {
    setKrakenSelection(verdict({})); // activity so the snapshot is non-null
    markRepairSucceeded();
    const m = collectKrakenTurnMetrics();
    expect(m?.repairTriggered).toBe(false);
    expect(m?.repairSucceeded).toBe(false);
  });
});

describe('reset', () => {
  it('clears transient counters but derives fresh from the registry', () => {
    recordSelectionOutcome({ latencyMs: 100, tokens: 50, degraded: false });
    markRepairTriggered();
    resetKrakenTurnMetrics();
    expect(collectKrakenTurnMetrics()).toBeNull(); // registry also empty here

    setKrakenSelection(verdict({}));
    const m = collectKrakenTurnMetrics();
    expect(m?.repairTriggered).toBe(false);
    expect(m?.candidateTokens).toBe(0);
    expect(m?.selectionLatencyMs).toBeUndefined();
  });
});
